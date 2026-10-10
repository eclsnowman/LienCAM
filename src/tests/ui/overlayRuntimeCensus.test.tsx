// @vitest-environment jsdom
//
// WO UI-70-R2 -- THE OVERLAY CENSUS. Runtime-grounded, and the verdict-bearing
// gate of this WO (DECISIONS 2026-07-17, the RUNTIME-GROUNDED CENSUS LAW).
//
// ===========================================================================
// WHY THIS FILE EXISTS: the census was bypassed TWICE, the same way both times
// ===========================================================================
// R0 keyed the domain on CSS TEXT. The auditor rendered a HUD reusing an
// already-dispositioned class from a new site: 18/18 green, EXIT CODE 0.
// R1 keyed it on an AST walk of the render tree. The auditor declared a local
// styled wrapper (verbatim: "a styled.div-style variable declaration contains no
// intrinsic JSX for walkBody to classify, so it creates neither a Surface nor an
// unresolved in-viewport hole") and rendered it over the fixture viewport:
// 31/31 green, EXIT CODE 0, while a real positioned HUD painted over the canvas.
//
// One root cause, twice: a STATIC census must MODEL how the code paints, and
// every model has a route it does not model. There is no third model that is
// safe -- there is only the next unmodelled route.
//
// So this census does not model. It MOUNTS THE REAL COMPONENTS AND READS THE
// LIVE DOM. A styled wrapper, an aliased component, a portal, a computed
// className, a class this stylesheet has never seen -- every one of them must
// produce a real element with a real out-of-flow computed position to be visible
// to Operator, and every one of them is therefore visible HERE, by construction and
// not by foresight. That is the property the two static rounds could not have.
//
// The static walk (src/tests/ui/overlayCohesionCensus.test.ts) is retained as an
// ADVISORY discovery tier. It never decides membership here. It is used for ONE
// thing -- telling this census what an authoring site is CALLED -- and the
// direction of failure is what makes that safe: a surface the static walk is
// blind to is still SEEN by this census, finds no name, and fails BY NAME as
// unmapped.
//
// ===========================================================================
// THE THREE RULES THAT KEEP IT FROM FAILING OPEN
// ===========================================================================
// 1. MEMBERSHIP IS POSITIONING, OVER THE WHOLE DOCUMENT (amendment A4).
//    document.body down -- never a viewport container's subtree, never DOM
//    ancestry, never geometric rect overlap. Ancestry fails open on
//    createPortal(<hud/>, document.body). Rect overlap fails open ALWAYS under
//    jsdom, which computes no layout: every getBoundingClientRect is zero, so
//    "is it over the viewport" is undecidable and would quietly answer "no".
// 2. THE STYLESHEET MUST BE LIVE, AND IS PROVEN LIVE (amendment A5).
//    jsdom loads none. Without injection every class-styled element reads
//    `static`, the census enumerates NOTHING, and every assertion passes -- a
//    green run over an empty domain. The canary refuses that.
// 3. NOTHING UNATTRIBUTABLE IS SKIPPED.
//    A floating element with no fiber, no owner, or no authoring site fails BY
//    NAME. An element nobody can name is what a bypass looks like.
//
// ===========================================================================
// THE MOUNTS (amendment A1) -- and the one rule about them
// ===========================================================================
// RULE: no component that AUTHORS census-domain DOM may be mocked. Only the
// WebGL/scene seam may be faked. Mocking ViewCube to null -- as the sim7
// precedent does, legitimately, for its own purposes -- would REMOVE two census
// surfaces and count as censusing a mock, which fails this WO. So ViewCube
// mounts REAL here, and only the five THREE.WebGLRenderer methods it calls are
// stubbed. Faked in this file, exhaustively:
//   - the CNCViewport class      (it constructs a real WebGLRenderer)
//   - THREE.WebGLRenderer        (ViewCube constructs its own, independently)
//   - HTMLCanvasElement 2d ctx   (ViewCube's makeLetterSprite non-null-asserts it)
//   - the workbench SceneRuntime (the injected seam the page is built to accept)
// That is the whole list, and every one is the scene/WebGL seam. Every component
// that authors DOM in this census is the real one.
//
// ###########################################################################
// # R4: THIS CENSUS IS HALF OF THE GATE. THE OTHER HALF IS THE LINT.        #
// #                                                                         #
// # DECISIONS 2026-07-17 ("UI-70 census re-scope") bounds the authoring     #
// # space by law and keeps THIS census verdict-bearing OVER THE SANCTIONED  #
// # SPACE. Its pair is src/tests/ui/overlayAuthoringLint.test.ts, and the   #
// # joint "no third state" claim is proven on real objects in               #
// # src/tests/ui/overlayGatePair.test.tsx. Read that file before concluding #
// # anything about what this one does NOT see.                              #
// #                                                                         #
// # WHAT THIS CENSUS DOES NOT SEE, stated plainly and BY DESIGN as of R4:   #
// # a Document that is not this one. A same-origin iframe's contentDocument #
// # can hold a position:fixed HUD that enumerateFloating() will never       #
// # reach -- the R3 audit proved exactly that and it is still true. It is   #
// # not a defect awaiting a sixth patch round: the ruling's answer is that  #
// # the LINT refuses the route at authoring, so the object cannot exist in  #
// # src/. The miss itself is committed as an assertion in the pair test     #
// # rather than left for an auditor to rediscover.                          #
// #                                                                         #
// # R4 DECISION ON THE EXOTIC WALKS (the ruling left this to the worker,    #
// # item 2: "its exotic-route walks may be retained or simplified -- your   #
// # call, documented"): RETAINED, unchanged, and deliberately so.           #
// #   - The ruling itself (item 2) keeps them "as regression evidence of    #
// #     the journey", and they are the only committed proof that the        #
// #     composed walk, the attachShadow instrumentation, and the            #
// #     UNINSPECTABLE refusal ever worked.                                  #
// #   - Simplifying them would DELETE coverage to celebrate a new gate --   #
// #     the lint is source-level and cannot catch a shadow root minted at   #
// #     RUNTIME by a dependency this repo does not control. Defence in      #
// #     depth costs nothing here; the walks are already written and green.  #
// #   - WORKER-CHARTER item 1: a rewrite that quietly weakens a prior       #
// #     round's coverage is the failure mode this program bounces on. The   #
// #     safe call is to touch none of it.                                   #
// #                                                                         #
// # STATUS (superseding R2's PARTIAL banner, which R3 made false and which  #
// # this replaces -- it still claimed A2 completeness, the exemption        #
// # artifact, OVERLAY-RUNTIME-KEYS.md and the real-component RED/GREEN      #
// # proofs were "NOT built" long after R3 built and gated every one):       #
// # COMPLETE. The engine, the runtime key scheme (A3), whole-document       #
// # positioning membership (A4), the stylesheet canary and its can-fail     #
// # proof (A5), A2's completeness direction at 80/80, and every bypass      #
// # caught BY NAME.                                                         #
// ###########################################################################

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import type { Operation, Project, Setup, Tool } from '../../types'

const NEVER_WIRED_3D = '__never_wired_3d' as Operation['type']
import { stampGenerationCurrent } from '../post/helpers'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, screen, waitFor } from '@testing-library/react'
import {
  injectAppStylesheet,
  measureCanary,
  enumerateFloating,
  enumerateAuthoredSites,
  composedDescendants,
  shadowInspectorIsInstalled,
  uninstallShadowInspectorForCanary,
  staleFiberSiteOf,
  siteOfElement,
  CANARY_EXPECTATIONS,
  type RuntimeSurface,
} from './support/overlayRuntimeCensus'
import { buildKeyMap, dispositionFor, renderKeyMapArtifact, type KeyMap } from './support/overlayKeyMap'
import {
  SURFACE_DISPOSITIONS,
  OUT_OF_VIEWPORT_DISPOSITIONS,
  CENSUS_EXEMPTIONS,
  EXPECTED_IN_FLOW,
  renderExemptionArtifact,
} from './support/overlayDispositions'
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stubCanvas2d } from '../model3d/stubCanvas2d'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// store uses persist(); the shim must be installed BEFORE the store import.
// (Same preamble as every other mounting test in this suite.)
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
  configurable: true,
})

// ---- the JSX site recorder (WO UI-70-R3) ----------------------------------
//
// This is NOT a mock of anything: the real jsxDEV is called and its element is
// returned untouched. It is instrumentation -- every element's props object is
// noted against the JSX site that created it, because React does not refresh
// `fiber._debugStack` on an update and R2's site attribution was therefore stale
// for every reused fiber (see support/overlayRuntimeCensus.ts, THE JSX SITE
// RECORDER, for React's own source lines and the real misattribution it caused).
//
// It must be hoisted above every component import, which vi.mock guarantees.
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

// ---- the scene/WebGL seam, and nothing else -------------------------------

vi.mock('../../lib/viewport/CNCViewport', async () => {
  const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
  // Every method Viewport.tsx's effects call WITHOUT optional chaining must
  // exist or the mount throws. Sourced from the sim7 precedent's own list.
  class CNCViewport {
    referenceImageHost = vi.fn(() => ({ runtime: createFakeSceneRuntime(), canvas: document.createElement('canvas') }))
    setSketchOverlayHost = vi.fn(); setSketchMenuPort = vi.fn(); setSketchUndoSink = vi.fn()
    setSketchDocumentPort = vi.fn(); applyNavPreset = vi.fn(); setCameraChangeHandler = vi.fn()
    restoreCameraState = vi.fn(); markCameraUserPositioned = vi.fn(); rebuildStock = vi.fn()
    dispose = vi.fn(); updateSketch = vi.fn(); setSketchEditingLayer = vi.fn()
    enterSketchView = vi.fn(); exitSketchView = vi.fn(); setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn(); setToolpathVisible = vi.fn(); setGridVisible = vi.fn()
    setAxesVisible = vi.fn(); setSeedOutlineVisible = vi.fn(); setMachineVisible = vi.fn()
    setShadingMode = vi.fn(); setSectionView = vi.fn(); renderToolpath = vi.fn()
    setHiddenToolpathRoles = vi.fn(); updateHeightPlanes = vi.fn(); setWCSOrigin = vi.fn()
    setBrepPickMode = vi.fn(); partPointToScreen = vi.fn(); setPartTransform = vi.fn()
    setMoveSelectCallback = vi.fn()
    clearPartLoopsOnFacePlane = vi.fn(); setPartProjectedLoops = vi.fn(); saveCameraState = vi.fn()
    clearScene = vi.fn(); setGridSpacing = vi.fn(); setMachineTravel = vi.fn()
    showCarvedStock = vi.fn(); clearCarvedStock = vi.fn()
    initStockSim = vi.fn(() => ({ x0: 0, y0: 0, nx: 8, ny: 8, cellSize: 1, stockTop: 8, stockBot: 0 }))
    disposeStockSim = vi.fn()
    // WO INT-13B (spec 3.2): Viewport.tsx's suspend/resume effect (declared
    // AFTER the mount effect on purpose, so it runs every mount) calls both of
    // these WITHOUT optional chaining. Added when the main merge (52ec79e9)
    // brought INT-13B's suspend/resume render-loop contract into Viewport.tsx
    // -- this list is "every method Viewport.tsx's effects call", so it must
    // track Viewport.tsx's real calls, not just the pre-merge set.
    suspendRender = vi.fn(); resumeRender = vi.fn()
    // MC-TIER1: ProgramPreview is now a real 3D viewport host too, so this list
    // tracks ITS unguarded calls as well, not just Viewport.tsx's.
    showToolMarker = vi.fn(); setToolMarkerPosition = vi.fn()
    setActiveToolpathSegment = vi.fn(); fitAll = vi.fn()
    setSetupSupportPlane = vi.fn(); setMachinePreviewCoordinateFrame = vi.fn()
    // WO-380: the intended-stock block (called only once a setup context is loaded).
    setIntendedStock = vi.fn()
  }
  // WO-1052 FINDING: CNCViewport's private static members are nominally
  // untypeable from outside its own declaration (see
  // owningStockViewportPick.ui64.test.tsx). Left untyped.
  return { CNCViewport }
})

// ViewCube builds its OWN real WebGLRenderer (ViewCube.tsx:58), independently of
// CNCViewport. Stub exactly the five methods it calls and leave every other
// THREE API real -- Scene, PerspectiveCamera, BoxGeometry, Raycaster and the
// rest are pure CPU-side and run fine in jsdom. ViewCube's DOM stays REAL.
// WO-1052 FINDING: real WebGLRenderer is missing here on purpose - its
// constructor demands an actual WebGL context, which jsdom does not have, so
// unlike CNCViewport/BridgeTransport this fake cannot extend the real class
// to inherit its private members (extending would run the very constructor
// this fixture exists to avoid). Left untyped; see mockContractBaseline.ts.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class WebGLRenderer {
    setSize(): void {}
    setPixelRatio(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer }
})

// ---------------------------------------------------------------------------
// The census harness
// ---------------------------------------------------------------------------

/** The mapping, derived once (see support/overlayKeyMap.ts for why it is
 *  derived and not hand-typed). */
const keyMap: KeyMap = buildKeyMap()

/** site -> the recipe that first observed it FLOATING. */
const observedFloating = new Map<string, string>()
/** site -> the recipe that first rendered an element there AT ALL. */
const observedRendered = new Map<string, string>()
/** Everything the census saw, for the artifact. */
const seen: Array<{ recipe: string; surface: RuntimeSurface; authoringKey: string | null }> = []

interface CensusReading {
  /** Floating elements this census cannot name -- THE fail-closed list. */
  unmapped: string[]
  /** authoring keys observed floating in this recipe. */
  floatingKeys: string[]
}

/** Read the live document: enumerate every out-of-flow element, resolve each to
 *  exactly one disposition entry, and hand back whatever could not be resolved.
 *
 *  This is THE assertion expression of the whole WO. Every recipe below runs it,
 *  and the bypass fixtures are fed to this same function -- not to a copy of it,
 *  and not to a re-statement of what it "would" do. */
function readCensus(recipe: string): CensusReading {
  const unmapped: string[] = []
  const floatingKeys: string[] = []
  for (const surface of enumerateFloating()) {
    if (surface.unattributed !== null) {
      unmapped.push(`${surface.key}\n      ${surface.unattributed}`)
      seen.push({ recipe, surface, authoringKey: null })
      continue
    }
    const entry = keyMap.bySite.get(surface.site)
    if (entry === undefined) {
      unmapped.push(
        `${surface.key}\n      position:${surface.position} (via ${surface.positionSource})`
        + `\n      authored at ${surface.site} -- the census cannot even NAME this site`,
      )
      seen.push({ recipe, surface, authoringKey: null })
      continue
    }
    // Named is not adjudicated. A site the static walk can name but that neither
    // disposition table claims is still a surface nobody has looked at.
    if (dispositionFor(entry.authoringKey) === undefined) {
      unmapped.push(
        `${entry.authoringKey}\n      position:${surface.position} (via ${surface.positionSource})`
        + `\n      authored at ${surface.site} -- NO disposition entry claims this surface`,
      )
      seen.push({ recipe, surface, authoringKey: null })
      continue
    }
    // The mapping must not be lying about what lives at this site: the live
    // element's owner and tag have to be the ones the authoring key names. (Its
    // classList is a SUBSET of the authored classes -- only the branches that
    // took -- so classes are reported, not equated.)
    expect(surface.ownerComponent, `runtime/authoring owner mismatch at ${surface.site}`).toBe(entry.component)
    expect(surface.tag, `runtime/authoring tag mismatch at ${surface.site}`).toBe(entry.tag)
    if (!observedFloating.has(surface.site)) observedFloating.set(surface.site, recipe)
    floatingKeys.push(entry.authoringKey)
    seen.push({ recipe, surface, authoringKey: entry.authoringKey })
  }
  for (const site of enumerateAuthoredSites()) {
    if (!observedRendered.has(site)) observedRendered.set(site, recipe)
  }
  return { unmapped, floatingKeys }
}

/** Run a recipe and assert the fail-closed direction on it (amendment A2:
 *  "every out-of-flow element enumerated in any mounted state maps to exactly
 *  one disposition entry - an unmapped element fails BY NAME"). */
function censusMustBeClosed(recipe: string): CensusReading {
  const reading = readCensus(recipe)
  expect(
    reading.unmapped,
    `[${recipe}] UNDISPOSITIONED FLOATING SURFACE(S) in the live DOM. Each is an element that is out of `
    + 'flow -- it paints OVER whatever is beneath it -- and that no disposition entry claims. However it was '
    + 'authored (css class, inline style, styled wrapper, aliased component, portal), it is a surface Operator can '
    + 'see and nobody has adjudicated it against docs/ui-ux/COHESION-STANDARD.md:\n'
    + reading.unmapped.map((u) => `  ${u}`).join('\n'),
  ).toEqual([])
  return reading
}

let restoreCanvas2d: (() => void) | null = null
let removeStylesheet: (() => void) | null = null

beforeEach(() => {
  mem.clear()
  restoreCanvas2d = stubCanvas2d()
  removeStylesheet = injectAppStylesheet()
})
afterEach(() => {
  cleanup()
  removeStylesheet?.(); removeStylesheet = null
  restoreCanvas2d?.(); restoreCanvas2d = null
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 0. The census can see. (amendment A5)
// ---------------------------------------------------------------------------

describe('WO UI-70-R2 / 0. the census is not vacuous', () => {
  it('THE CANARY: the app stylesheet is live, so class-positioned elements read their REAL position', () => {
    // If this fails, EVERY assertion in this file is meaningless: jsdom loads no
    // stylesheet of its own (the repo's own committed statement,
    // AnchoredValueEntry.cohesion.test.tsx:8-11), so without the injection every
    // class-styled element reports `static`, the enumeration returns nothing,
    // and the whole census passes while looking at an empty domain. That is the
    // fail-open class this law exists to forbid, so it is asserted FIRST and by
    // name rather than assumed from the fact that the other tests are green.
    const results = measureCanary()
    expect(results.map((r) => `${r.className}=${r.actual}`)).toEqual(
      CANARY_EXPECTATIONS.map((c) => `${c.className}=${c.expected}`),
    )
  })

  it('THE CANARY, proven able to fail: with no stylesheet injected, the positions vanish', () => {
    // The canary is itself a probe, and a probe that cannot fail is not a gate
    // (WORKER-CHARTER item 1). So: remove the stylesheet and watch the same
    // measurement collapse to `static` -- which is exactly what a silently
    // uninjected census would have read while reporting success.
    removeStylesheet?.(); removeStylesheet = null
    const bare = measureCanary()
    expect(bare.map((r) => r.actual)).toEqual(['static', 'static', 'static', 'static'])
    removeStylesheet = injectAppStylesheet()
    expect(measureCanary().map((r) => r.actual)).toEqual(['absolute', 'absolute', 'fixed', 'static'])
  })

  it('the derived key map covers the disposition domain exactly, and is NOT lossy (amendment A3)', () => {
    // The map names EVERY floating surface app-wide, because the runtime
    // membership test is positioning alone over the whole document (A4) and any
    // element it renders must be nameable. Its IN-VIEWPORT subset is exactly the
    // static tier's 74 -- so the two tiers still adjudicate one domain, and a
    // disposition with no live authoring site fails here as stale. The naming
    // walk may conservatively include additional unresolved candidates; live
    // computed positioning still decides whether they enter the census.
    const dispositioned = Object.keys(SURFACE_DISPOSITIONS).sort()
    const namedInViewport = new Set(keyMap.entries.filter((e) => e.inViewport).map((e) => e.authoringKey))
    const staleInViewport = dispositioned.filter((key) => !namedInViewport.has(key))
    expect(staleInViewport, `stale SURFACE_DISPOSITIONS entr(ies): ${staleInViewport.join(' | ')}`).toEqual([])
    expect(keyMap.entries.length, 'the whole-document domain is WIDER than the in-viewport 74')
      .toBeGreaterThan(dispositioned.length)

    // Every out-of-viewport disposition must still name a real live site.
    const stale = Object.keys(OUT_OF_VIEWPORT_DISPOSITIONS).filter((k) => !keyMap.byAuthoringKey.has(k))
    expect(stale, `stale OUT_OF_VIEWPORT_DISPOSITIONS entr(ies): ${stale.join(' | ')}`).toEqual([])
    // ...and must not double-claim a surface the in-viewport table already owns.
    const both = Object.keys(OUT_OF_VIEWPORT_DISPOSITIONS).filter((k) => k in SURFACE_DISPOSITIONS)
    expect(both, `surface(s) dispositioned in BOTH tables: ${both.join(' | ')}`).toEqual([])

    // A3's literal demand: "A lossy or invented mapping that lets two
    // disposition entries collapse into one runtime key fails the census."
    const runtimeKeys = keyMap.entries.map((e) => e.runtimeKey)
    const collapsed = runtimeKeys.filter((k, i) => runtimeKeys.indexOf(k) !== i)
    expect(collapsed, `two disposition entries share ONE runtime key:\n${collapsed.join('\n')}`).toEqual([])
    expect(new Set(keyMap.entries.map((e) => e.site)).size, 'two entries share one JSX site').toBe(keyMap.entries.length)

    // And the reason the scheme needs a stable ordinal, pinned as a fact rather
    // than left as a claim in a comment: owner+tag+classList ALONE collapses
    // real members of this domain in pairs.
    const bare = keyMap.entries.map((e) => `${e.file}:${e.component} > ${e.tag}.${e.authoredClasses.join('.')}`)
    const dupes = [...new Set(bare.filter((k, i) => bare.indexOf(k) !== i))]
    expect(
      dupes.length,
      'the bare owner+tag+classList scheme is expected to be LOSSY on this tree (that is why the runtime key '
      + 'carries the authoring ordinal). If this is 0, the ordinal may no longer be load-bearing -- re-read A3.',
    ).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 0b. THE COMMITTED ARTIFACTS (WO UI-70-R3: amendment A3, and A2's exemptions)
// ---------------------------------------------------------------------------
//
// Both artifacts are GENERATED from the code above and gated byte-for-byte here.
// The R2 audit failed this WO for publishing neither while the source claimed
// both: "The source comment says the mapping is published to
// coordination/evidence/UI-70/OVERLAY-RUNTIME-KEYS.md, yet that path is absent
// and no artifact-drift assertion exists."
//
// A generated-and-gated artifact is evidence: anyone can regenerate it and get
// the same bytes, and it cannot quietly disagree with the code it claims to
// describe. A hand-written one is a screenshot of somebody's intent, which is
// what A3 means by an "invented mapping".

describe('WO UI-70-R3 / 0b. the committed artifacts match their derivation', () => {
  // WO-2685 publishes the complete current derivations in its owned evidence
  // directory, retaining the historical UI-70 snapshots unchanged.
  const EVIDENCE = path.join(process.cwd(), 'src', 'tests', 'evidence', 'WO-2685')

  /** Writes when UI70_WRITE_KEYS=1 -- the regeneration path the artifacts' own
   *  headers document -- and otherwise only ever reads. */
  function gateArtifact(fileName: string, rendered: string): void {
    const file = path.join(EVIDENCE, fileName)
    // Write only a REAL change: rewriting an unchanged artifact with LF endings left
    // CRLF files "modified" in the main checkout, and that EOL-only dirt made a
    // lane's gate refuse to measure (2026-09-23, WO-1876).
    const eol = (s: string) => s.replace(/\r\n/g, '\n')
    if (process.env.UI70_WRITE_KEYS === '1'
      && !(existsSync(file) && eol(readFileSync(file, 'utf8')) === eol(rendered))) writeFileSync(file, rendered, 'utf8')
    expect(existsSync(file), `${fileName} is NOT COMMITTED. A3 requires the mapping to be a committed artifact; `
      + "regenerate it in PowerShell with $env:UI70_WRITE_KEYS='1'; npx vitest run "
      + 'src/tests/ui/overlayRuntimeCensus.test.tsx; Remove-Item Env:UI70_WRITE_KEYS').toBe(true)
    // Normalised for line endings only: this repo has CRLF files and git may
    // rewrite the checkout, which would make a byte gate fail for a reason that
    // has nothing to do with drift (WORKER-CHARTER item 11's CRLF trap).
    const onDisk = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    expect(
      onDisk,
      `${fileName} has DRIFTED from the derivation it is generated from. Every difference is either a real change to `
      + 'the overlay domain (regenerate and review the diff) or a hand edit (do not hand-edit a generated artifact).',
    ).toBe(rendered.replace(/\r\n/g, '\n'))
  }

  it('OVERLAY-RUNTIME-KEYS.md is byte-identical to renderKeyMapArtifact(buildKeyMap()) (A3)', () => {
    gateArtifact('OVERLAY-RUNTIME-KEYS.md', renderKeyMapArtifact(keyMap))
  })

  it('the committed mapping is invariant to informational source-coordinate drift', () => {
    const shifted: KeyMap = {
      ...keyMap,
      entries: keyMap.entries.map((entry) => ({
        ...entry,
        site: `${entry.file}@${entry.line + 1}:${entry.column}`,
        line: entry.line + 1,
      })),
    }
    expect(renderKeyMapArtifact(shifted)).toBe(renderKeyMapArtifact(keyMap))
  })

  it('OVERLAY-CENSUS-EXEMPTIONS.md is byte-identical to the exemption list it publishes (A2)', () => {
    gateArtifact('OVERLAY-CENSUS-EXEMPTIONS.md', renderExemptionArtifact())
  })
})

// ---------------------------------------------------------------------------
// 1. THE BYPASSES. The whole point of the round. (WO required shape item 1)
// ---------------------------------------------------------------------------
//
// "The R1 auditor's styled-wrapper bypass AND the R0 CSS bypass become committed
//  regression fixtures: add each bypass overlay, census test FAILS; remove,
//  passes (both runs committed)."
//
// Each bypass is fed to readCensus() -- the REAL assertion expression every real
// recipe below runs -- and must come back naming the intruder. The CleanViewport
// control proves the fixture host itself is not what fails.

describe('WO UI-70-R2 / 1. the bypasses that defeated the static censuses', () => {
  it('GREEN CONTROL: the fixture viewport host alone is clean -- the host is not what fails', async () => {
    const { CleanViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<CleanViewport />)
    expect(readCensus('control:clean-fixture').unmapped).toEqual([])
  })

  it('RED: BYPASS 1 -- the R1 auditor\'s styled/aliased wrapper (THE BLOCKER of this round)', async () => {
    // The static census is 31/31 GREEN with this exact component rendered. This
    // census sees two positioned elements nobody dispositioned, and names them.
    const { StyledWrapperBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<StyledWrapperBypassViewport />)
    const { unmapped } = readCensus('bypass:styled-wrapper')
    expect(unmapped.length, 'the styled wrapper AND the aliased component must both be caught').toBe(2)
    expect(unmapped.join('\n')).toMatch(/StyledComponent > div\.sc-ui70-/)
    expect(unmapped.join('\n')).toMatch(/AliasedInlineHud > div/)
    expect(unmapped.join('\n'), 'the census must say WHERE the surface was authored').toMatch(/overlayRuntimeBypass\.fixture\.tsx/)
    // The routes it caught them by: a runtime-injected stylesheet rule, and an
    // inline style. Neither is anything the source said.
    expect(unmapped.join('\n')).toMatch(/position:absolute \(via stylesheet\)/)
    expect(unmapped.join('\n')).toMatch(/position:fixed \(via inline\)/)
  })

  it('RED: BYPASS 2 -- createPortal into document.body, positioned ABSOLUTE (amendment A4)', async () => {
    // Outside every viewport container's subtree, so a subtree walk misses it.
    // Absolute, not fixed, so a "fixed-is-in-domain-from-anywhere" shortcut
    // misses it too. Caught because membership is positioning over the WHOLE
    // document, and nothing else.
    const { PortalBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<PortalBypassViewport />)
    await waitFor(() => { expect(document.body.textContent).toContain('portal HUD') })
    const { unmapped } = readCensus('bypass:portal-to-body')
    expect(unmapped.length).toBe(1)
    expect(unmapped.join('\n')).toMatch(/PortalBypassViewport > div/)
    expect(unmapped.join('\n')).toMatch(/position:absolute \(via inline\)/)
  })

  it('RED: BYPASS 3 -- the R0 auditor\'s HUD reusing the dispositioned .sketch-prompt-bar class', async () => {
    const { ReusedClassBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<ReusedClassBypassViewport />)
    const { unmapped } = readCensus('bypass:reused-class')
    expect(unmapped.length).toBe(1)
    expect(unmapped.join('\n')).toMatch(/ReusedClassBypassViewport > div\.sketch-prompt-bar/)
    // The precondition that makes this prove anything: the class IS
    // dispositioned, at SketchPromptBar's real site. That must buy the impostor
    // at a DIFFERENT site exactly nothing.
    expect(
      Object.keys(SURFACE_DISPOSITIONS).some((k) => k.includes('SketchPromptBar') && k.includes('sketch-prompt-bar')),
      'precondition: .sketch-prompt-bar must already be dispositioned at its real site, or this proves nothing',
    ).toBe(true)
  })

  it('RED: BYPASS 4 -- a web component painting from inside SHADOW DOM (the R2 audit\'s BLOCKER)', async () => {
    // Verbatim from the R2 audit: "enumerateFloating() walks only
    // document.body.querySelectorAll('*'), which never descends into an
    // element's ShadowRoot. A web component can therefore render a real
    // absolute/fixed/sticky HUD while its light-DOM host remains static, and the
    // census reports no surface." The auditor's exact probe is the first of the
    // three below; the closed root and the nested root are the shapes a
    // descend-once, trust-`el.shadowRoot` fix would still miss.
    const { ShadowHudBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<ShadowHudBypassViewport />)
    await waitFor(() => { expect(document.querySelector('ui70-open-shadow-hud')?.shadowRoot).not.toBeNull() })
    const { unmapped } = readCensus('bypass:shadow-dom')
    const text = unmapped.join('\n')
    expect(text, 'the auditor\'s own probe: an OPEN root, inline position:fixed').toMatch(/div\.auditor-shadow-hud/)
    expect(text, 'a CLOSED root reads back null through el.shadowRoot -- only the attachShadow inspector reaches it')
      .toMatch(/div\.auditor-closed-shadow-hud/)
    expect(text, 'a root INSIDE a root -- a descend-once fix passes the auditor\'s probe and still misses this')
      .toMatch(/div\.auditor-nested-shadow-hud/)
    // Each is caught for the RIGHT reason: it has no React fiber at all (a web
    // component builds its DOM imperatively), so it is unattributable, which
    // this census refuses rather than skips.
    expect(unmapped.length).toBe(3)
    expect(text).toMatch(/no React fiber/)
  })

  it('RED: BYPASS 4b -- a custom element whose closed root is attached BEHIND the inspector', async () => {
    // The honest limit of instrumentation: this element grabs a pristine
    // attachShadow off a fresh iframe's Element.prototype, so the inspector
    // never sees the call and the root is unreachable by any means. The census
    // cannot prove the element is shadow-free -- so it REFUSES it by name. A
    // skip here is a silent bypass; that is the whole lesson of this WO.
    const { UninspectableShadowBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<UninspectableShadowBypassViewport />)
    await waitFor(() => { expect(document.querySelector('ui70-uninspectable-hud')).not.toBeNull() })
    const { unmapped } = readCensus('bypass:shadow-uninspectable')
    expect(unmapped.join('\n')).toMatch(/<UNINSPECTABLE> ui70-uninspectable-hud/)
    expect(unmapped.join('\n')).toMatch(/indistinguishable from no root at all/)
  })

  it('THE SHADOW CANARY, proven able to fail: without the inspector the census REFUSES to report', async () => {
    // The composed walk is only as good as the inspector that records closed
    // roots, and a probe that cannot fail is not a gate (WORKER-CHARTER item 1).
    // So: uninstall the inspector and watch the census refuse outright rather
    // than report a clean domain it cannot see. This is the R2 defect's own
    // shape -- a census enumerating one tree out of several and calling it
    // green -- made impossible to reach silently.
    const { ShadowHudBypassViewport } = await import('./fixtures/overlayRuntimeBypass.fixture')
    render(<ShadowHudBypassViewport />)
    await waitFor(() => { expect(document.querySelector('ui70-open-shadow-hud')?.shadowRoot).not.toBeNull() })

    const restore = uninstallShadowInspectorForCanary()
    try {
      expect(shadowInspectorIsInstalled()).toBe(false)
      expect(() => enumerateFloating()).toThrow(/shadow inspector is NOT installed/)
    } finally {
      restore()
    }
    expect(shadowInspectorIsInstalled()).toBe(true)
    // ...and with it restored, the same document reads its three shadow HUDs.
    expect(readCensus('bypass:shadow-dom-restored').unmapped.length).toBe(3)
  })

  it('CONTROL: the composed walk sees a shadow root\'s IN-FLOW content without inventing surfaces', async () => {
    // Non-vacuity in the other direction: the walk must descend into shadow
    // roots and find nothing to complain about when nothing there floats. If
    // this fails, the shadow rule is catching trees rather than surfaces.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    const inFlow = document.createElement('div')
    inFlow.textContent = 'ordinary shadow content'
    root.appendChild(inFlow)
    expect(composedDescendants(document.body)).toContain(inFlow)
    expect(readCensus('control:shadow-in-flow').unmapped).toEqual([])
    host.remove()
  })

  it('CONTROL: the fixtures are unreachable from the app, so they cannot pollute the real census', () => {
    expect(keyMap.entries.some((e) => e.file.includes('fixtures/'))).toBe(false)
    expect(Object.keys(SURFACE_DISPOSITIONS).some((k) => k.includes('fixture'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. THE MOUNT RECIPES (amendments A1, A2, A7)
// ---------------------------------------------------------------------------
//
// Each recipe MOUNTS REAL COMPONENTS and asserts the fail-closed direction on
// whatever the live DOM then contains. Between them they must ACCOUNT FOR every
// one of the 74 disposition entries -- see section 3, which is the assertion
// that makes this list complete rather than merely long.
//
// Recipes are grouped by the state they drive, not by convenience: several
// members are MUTUALLY EXCLUSIVE with each other by construction (SetupModal's
// vertex-pick banner is an EARLY RETURN that replaces its own modal backdrop;
// all three of NewOperationModal's loop-pick banners likewise), so "one mount
// per component" is not available -- it is one mount per STATE.

const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

function resetStore(): void {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
}

const CENSUS_SETUP_ID = 'census-setup'
const CENSUS_GEO_ID = 'census-geo'

const CENSUS_WCS = {
  id: 'wcs-1', label: 'G54', fixtureOffset: 54,
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
}

function seedProject(geometry: unknown[]): void {
  const setup = { id: CENSUS_SETUP_ID, name: 'Census Setup', wcs: CENSUS_WCS, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: CENSUS_SETUP_ID },
    } as never)
  })
}

/** A STEP-style brep geometry, for the B-rep pick banner. Shape lifted from the
 *  committed precedent ThreadMillModal.smoke.test.tsx:70-75. */
function seedSetupWithBrep(): void {
  seedProject([{
    id: CENSUS_GEO_ID, name: 'census-boss.step', type: 'brep', format: 'step', loaded: true, loops: [],
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 } },
  }])
}

/** A setup with a three-loop 2D geometry, seeded straight into the store.
 *
 *  NewOperationModal early-returns null without a setup it can find via
 *  activeSetupId (NewOperationModal.tsx:21, `if (!isOpen || !setup) return
 *  null`), so this is the difference between mounting the modal and mounting
 *  nothing -- exactly the vacuity each recipe's own floatingKeys assertion is
 *  there to catch. Shape lifted from the committed precedent
 *  ThreadMillModal.smoke.test.tsx:42-65; the cast is that precedent's too (the
 *  modal reads only id/name/type/loops and the loop fields below). */
function seedSetupWithLoops(): void {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'loop-c', points: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
  ]
  const geometry = [{
    id: CENSUS_GEO_ID, name: 'census-part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: CENSUS_SETUP_ID, name: 'Census Setup', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: CENSUS_SETUP_ID },
    } as never)
  })
}

describe('WO UI-70-R2 / 2a. recipe: the CAM viewport host (real Viewport, only the scene seam faked)', () => {
  beforeEach(resetStore)

  it('default mount: the viewport chrome that renders unconditionally', async () => {
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    const { floatingKeys } = censusMustBeClosed('cam-viewport:default')
    // Non-vacuity: this recipe is supposed to REACH the chrome, not merely not
    // fail. A mount that renders nothing passes a fail-closed assertion.
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-overlay')
    expect(floatingKeys).toContain('components/viewport/ViewCube.tsx:ViewCube > div.view-cube-wrap')
    expect(floatingKeys).toContain('components/viewport/ViewCube.tsx:ViewCube > span.view-cube-label')
    expect(floatingKeys).toContain('components/viewport/ViewportToolbar.tsx:ViewportToolbar > div.viewport-toolbar')
  })
})


describe('WO UI-70-R2 / 2b. recipe: CAM viewport, state-driven chrome', () => {
  beforeEach(resetStore)

  it('selection state: the selected-face readout', async () => {
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    act(() => {
      useCamStore.setState((s) => ({ viewer: { ...s.viewer, selectedFaceIds: ['f1', 'f2'] } }))
    })
    const { floatingKeys } = censusMustBeClosed('cam-viewport:face-selected')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-selection-info')
  })

  it('toolpath mode + expanded legend: the toolpath legend chip AND its list', async () => {
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    act(() => {
      useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'toolpath' } }))
      useUiPrefs.setState({ tpLegendExpanded: true })
    })
    const { floatingKeys } = censusMustBeClosed('cam-viewport:toolpath-legend-expanded')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.tp-legend-wrap')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.tp-legend')
  })

  it('toolpath feed summary: the estimated and acceleration-absent metric branches', async () => {
    const { ToolpathFeedEstimateSummary } = await import('../../components/toolpath/ToolpathFeedEstimatePanel')
    const rendered = render(
      <ToolpathFeedEstimateSummary
        operationName="WO-1088 census operation"
        units="mm"
        commandedFeedMmMin={6000}
        theoreticalCycleTimeMs={1000}
        estimate={{
          segments: [],
          estimatedCycleTimeMs: 2000,
          theoreticalCycleTimeMs: 1000,
          commandedFeed: { minMmMin: 6000, typicalMmMin: 6000 },
          estimatedFeed: { minMmMin: 2500, typicalMmMin: 3000 },
        }}
        rpm={20_000}
        fluteCount={2}
      />,
    )
    expect(screen.getByTestId('estimated-real-feed'), 'positive recipe did not reach the estimated branch').toBeTruthy()
    expect(screen.getByTestId('estimated-cycle-time'), 'positive recipe did not reach the cycle-time branch').toBeTruthy()
    expect(screen.getByTestId('estimated-chipload'), 'positive recipe did not reach the chipload branch').toBeTruthy()
    expect(screen.getByTestId('feed-estimate-limit'), 'positive recipe did not reach the estimate disclaimer').toBeTruthy()
    censusMustBeClosed('toolpath-feed-estimate:positive')

    rendered.rerender(
      <ToolpathFeedEstimateSummary
        operationName="WO-1088 census operation"
        units="mm"
        commandedFeedMmMin={6000}
        theoreticalCycleTimeMs={1000}
        estimate={null}
        error="Acceleration not set in the machine definition"
      />,
    )
    expect(screen.getByTestId('acceleration-not-set'), 'absent recipe did not reach the acceleration-missing branch').toBeTruthy()
    censusMustBeClosed('toolpath-feed-estimate:acceleration-absent')
  })

  it('simulation mode: the sim panel, and its speed flyout opened by a real click', async () => {
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    act(() => { useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'simulation' } })) })
    const chip = document.querySelector('[data-tooltip="Playback speed"]')
    expect(chip, 'the sim speed chip is the flyout\'s only opener -- recipe stale').not.toBeNull()
    fireEvent.click(chip as Element)
    const { floatingKeys } = censusMustBeClosed('cam-viewport:simulation-speed-flyout')
    expect(floatingKeys).toContain('components/simulation/SimulationPanel.tsx:SimulationPanel > div.sim-panel#2')
    expect(floatingKeys).toContain('components/simulation/SimulationPanel.tsx:SimulationPanel > div.sim-speed-flyout')
  })

  it('display-mode flyout opened by a real click', async () => {
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    const btn = document.querySelector('.display-mode-gizmo-btn')
    expect(btn, 'the display-mode gizmo button is the flyout\'s only opener -- recipe stale').not.toBeNull()
    fireEvent.click(btn as Element)
    const { floatingKeys } = censusMustBeClosed('cam-viewport:display-mode-flyout')
    expect(floatingKeys).toContain('components/viewport/DisplayModeControl.tsx:DisplayModeControl > div.display-mode-control')
    expect(floatingKeys).toContain('components/viewport/DisplayModeControl.tsx:DisplayModeControl > div.planes-flyout')
  })
})

describe('WO UI-70-R2 / 2c. recipe: ViewportOverlay interaction modes (the two mode banners)', () => {
  beforeEach(resetStore)

  // The two banners are the reason the runtime key carries a stable ordinal:
  // same owner, same tag, same class, TWO authoring sites, and the census must tell
  // them apart or "fixing one" silently marks the other clean.
  it('lay-on-face: banner #1 (ViewportOverlay.tsx:107)', async () => {
    const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
    render(<ViewportOverlay interactionMode="lay-on-face" />)
    const { floatingKeys } = censusMustBeClosed('viewport-overlay:lay-on-face')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner')
    expect(floatingKeys).not.toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner#2')
  })

  it('project-plane: banner #2 (ViewportOverlay.tsx:116) -- a DIFFERENT key, from the same class', async () => {
    const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
    render(<ViewportOverlay interactionMode="project-plane" />)
    const { floatingKeys } = censusMustBeClosed('viewport-overlay:project-plane')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner#2')
    expect(floatingKeys).not.toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner')
  })

  it('sketch mode with an empty sketch: the shortcut hint', async () => {
    const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
    act(() => { useCamStore.getState().startNewSketch() })
    render(<ViewportOverlay interactionMode="normal" />)
    const { floatingKeys } = censusMustBeClosed('viewport-overlay:sketch-empty-hint')
    expect(floatingKeys).toContain('components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.sketch-empty-hint')
  })
})

describe('WO UI-70-R2 / 2d. recipe: the workbench viewport host + its overlays', () => {
  beforeEach(resetStore)

  it('the workbench page mounts real through the scene-runtime seam: its shell and its canvas', async () => {
    // Amendment A1(a): SolidsWorkbenchPage mounted REAL via the injected
    // createSceneRuntime seam -- the same seam 50+ committed tests already use.
    // The scene runtime is the WebGL seam; every DOM-authoring component here is
    // the real one.
    const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
    const { createLocalGeomService } = await import('../../geom')
    const { SolidsWorkbenchPage } = await import('../../components/model3d')
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={() => {
          const rt = createFakeSceneRuntime()
          rt.projectToCanvasResult = { x: 200, y: 200 }
          return rt
        }}
      />,
    )
    await waitFor(() => { expect(document.querySelector('[data-testid="solids-workbench-canvas"]')).not.toBeNull() })
    const { floatingKeys } = censusMustBeClosed('workbench:default')
    expect(floatingKeys).toContain('components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div')
    expect(floatingKeys).toContain('components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > canvas')
  })

  // WO GEO-UNIFY-S1b: ModelWorkspaceHeader.tsx's own row only renders once a
  // real Model Item is active (activeModelItemId !== null) -- the mount above
  // never sets one, so this is a SEPARATE recipe, mirroring 523dc5256's own
  // shape (dispositioning a new surface requires a live recipe that actually
  // reaches it, not just a table entry).
  it('the Model workspace header (GEO-UNIFY-S1b): the in-panel row that replaced the old floating "Editing:" banner', async () => {
    const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
    const { createLocalGeomService } = await import('../../geom')
    const { SolidsWorkbenchPage } = await import('../../components/model3d')
    let itemId = ''
    act(() => { itemId = useCamStore.getState().addModelItem() })
    render(
      <SolidsWorkbenchPage
        modelItemId={itemId}
        createClient={createLocalGeomService}
        createSceneRuntime={() => {
          const rt = createFakeSceneRuntime()
          rt.projectToCanvasResult = { x: 200, y: 200 }
          return rt
        }}
      />,
    )
    await waitFor(() => { expect(document.querySelector('[data-testid="solids-workbench-canvas"]')).not.toBeNull() })
    // The header row itself (a plain in-flow .panel-header, no position) never
    // floats -- its own dropdown does, and only while open. Open it so the
    // backdrop + menu (the two ACTUALLY floating pieces) both render.
    const trigger = document.querySelector('[data-testid="model-workspace-switcher-trigger"]')
    expect(trigger, 'model-workspace-switcher-trigger missing -- recipe stale').not.toBeNull()
    fireEvent.click(trigger as Element)
    await waitFor(() => { expect(document.querySelector('[data-testid="model-workspace-switcher-menu"]')).not.toBeNull() })
    const { floatingKeys } = censusMustBeClosed('workbench:model-workspace-header-switcher-open')
    expect(floatingKeys).toContain('components/model3d/ModelWorkspaceHeader.tsx:ModelWorkspaceHeader > div')
    expect(floatingKeys).toContain('components/model3d/ModelWorkspaceHeader.tsx:ModelWorkspaceHeader > div.model-workspace-switcher-menu')
  })

  it('the anchored value entry -- the surface Operator rejected and this WO restyled', async () => {
    const { AnchoredValueEntry } = await import('../../components/model3d/workbench/AnchoredValueEntry')
    render(
      <AnchoredValueEntry
        testId="census-anchor-entry"
        anchorWorldPoint={{ x: 20, y: 5, z: 20 }}
        projectToCanvas={() => ({ x: 400, y: 300 })}
        title="Resize hole"
        currentValueLabel="Current diameter"
        currentValueText="6 mm"
        deltaLabel="Diameter change"
        initialDraft="8"
        unitSuffix="mm"
        validate={() => ({ ok: true, deltaText: '+2 mm' })}
        onApply={async () => undefined}
        onCancel={() => {}}
      />,
    )
    // It paints nothing until its anchor projects on the rAF tick -- a real
    // frame, not a faked timer.
    await waitFor(() => { expect(document.querySelector('[data-testid="census-anchor-entry"]')).not.toBeNull() })
    const { floatingKeys } = censusMustBeClosed('workbench:anchored-value-entry')
    expect(floatingKeys).toContain('components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry > div.workbench-anchor-entry')
  })

  it('the confirm bar in its refusal state -- the hint bar Operator blessed', async () => {
    const { WorkbenchConfirmBar } = await import('../../components/model3d/workbench/WorkbenchConfirmBar')
    render(
      <WorkbenchConfirmBar
        testId="census-confirm-bar"
        message="Refused"
        refusal
        actions={[{ testId: 'census-done', label: 'Done', variant: 'primary', onClick: () => {} }]}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('workbench:confirm-bar-refusal')
    expect(floatingKeys).toContain('components/model3d/workbench/WorkbenchConfirmBar.tsx:WorkbenchConfirmBar > div.workbench-confirm-bar.workbench-confirm-bar--refusal')
  })

  it('the workbench display-mode chip and its flyout (which is also what renders NumericInput)', async () => {
    const { WorkbenchDisplayMode } = await import('../../components/model3d/workbench/WorkbenchDisplayMode')
    render(<WorkbenchDisplayMode mode="unshaded" onModeChange={() => {}} />)
    const btn = document.querySelector('[data-testid="workbench-display-mode-btn"]')
    expect(btn, 'the workbench display-mode button is the flyout\'s only opener -- recipe stale').not.toBeNull()
    fireEvent.click(btn as Element)
    const { floatingKeys } = censusMustBeClosed('workbench:display-mode-flyout')
    expect(floatingKeys).toContain('components/model3d/workbench/WorkbenchDisplayMode.tsx:WorkbenchDisplayMode > div.display-mode-control')
    expect(floatingKeys).toContain('components/model3d/workbench/WorkbenchDisplayMode.tsx:WorkbenchDisplayMode > div.planes-flyout')
  })

  it('the workbench tree context menu and its delete-confirm dialog (both inline-styled -- booked)', async () => {
    const { TreeContextMenu, DeleteConfirmDialog } = await import('../../components/model3d/tree/TreeContextMenu')
    render(<TreeContextMenu x={10} y={10} onClose={() => {}} />)
    let reading = censusMustBeClosed('workbench:tree-context-menu')
    expect(reading.floatingKeys).toContain('components/model3d/tree/TreeContextMenu.tsx:TreeContextMenu > div')
    expect(reading.floatingKeys).toContain('components/model3d/tree/TreeContextMenu.tsx:TreeContextMenu > div#2')
    cleanup()
    render(<DeleteConfirmDialog targetName="Extrude1" consumerNames={[]} onCancel={() => {}} onConfirm={() => {}} />)
    reading = censusMustBeClosed('workbench:tree-delete-confirm')
    expect(reading.floatingKeys).toContain('components/model3d/tree/TreeContextMenu.tsx:DeleteConfirmDialog > div')
    expect(reading.floatingKeys).toContain('components/model3d/tree/TreeContextMenu.tsx:DeleteConfirmDialog > div#2')
  })

  it('the shared workbench dialog shell -- transparent scrim plus floating property palette', async () => {
    const { DialogShell } = await import('../../components/model3d/dialogs/DialogShell')
    render(<DialogShell title="Census" floatingPalette onApply={() => {}} onCancel={() => {}}><div /></DialogShell>)
    const { floatingKeys } = censusMustBeClosed('workbench:dialog-shell')
    // Re-keyed (was div.modal-backdrop only): allowViewportInteraction now
    // conditionally adds modal-backdrop-transparent, so the static walk resolves
    // BOTH branches at this one JSX site regardless of which branch this
    // particular render (default props) actually took.
    expect(floatingKeys).toContain('components/model3d/dialogs/DialogShell.tsx:DialogShell > div.modal-backdrop.modal-backdrop-transparent')
    expect(floatingKeys).toContain('components/model3d/dialogs/DialogShell.tsx:DialogShell > div.modal-container')
  })

  it('the Draft command card -- movable property palette with live viewport picking', async () => {
    const { DraftDialog } = await import('../../components/model3d/dialogs/DraftDialog')
    const { CommandHistory, FeatureDag } = await import('../../doc')
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: [],
      payload: { opType: 'extrude', name: 'Extrude F1' },
    })
    const history = new CommandHistory(dag)
    render(
      <DraftDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['face1']}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('workbench:draft-command-card')
    expect(floatingKeys).toContain('components/model3d/dialogs/DraftDialog.tsx:DraftDialog > aside.draft-command-card')
  })

  it('the Form palette -- docked as a column beside the rail while form mode is open, no floating surface (Form stage 50)', async () => {
    const { FormPanel } = await import('../../components/model3d/form/FormPanel')
    const session = {
      active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
      canUndo: false, canRedo: false, railSections: [],
    }
    render(<FormPanel session={session} />)
    const { floatingKeys } = censusMustBeClosed('workbench:form-palette')
    // in the page's flow beside the rail (it floated over the view's top-left before stage 50): nothing of it floats
    expect(floatingKeys.filter((k) => k.includes('FormPanel'))).toEqual([])
  })

  it('the Relief palette and its height map -- relief mode with a picture on a face (WO-2171, WO-2201)', async () => {
    const { ReliefPanel } = await import('../../components/model3d/relief/ReliefPanel')
    const { useReliefStore } = await import('../../components/model3d/relief/reliefStore')
    const { defaultSettings } = await import('../../relief/reliefHeights')
    const picture = { cols: 4, rows: 4, grey: new Float32Array(16).fill(0.5), bitDepth: 8 as const }
    const face = {
      centre: { x: 0, y: 0, z: 10 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
      widthMm: 40, heightMm: 40,
    }
    // the map only mounts once a picture sits on a face, so the store carries all three
    useReliefStore.getState().openSession({
      featureId: null, name: 'Relief',
      target: { ownerId: 'B1', faceId: 'f1', face, bodyName: 'Body 1' },
      image: { dataUrl: 'data:image/png;base64,', fileName: 'art.png', cols: 4, rows: 4, bitDepth: 8 },
      picture, settings: defaultSettings(picture, face, null),
    })
    const session = {
      active: true, open: () => {}, apply: () => {}, cancel: () => {}, openFile: async () => {},
      fileInputRef: { current: null }, pickAt: () => {}, settled: () => null, railSections: [],
    }
    // jsdom's canvas stub has no image data; a null context is drawThumbnail's own early return
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    try {
      render(<ReliefPanel session={session} />)
      const { floatingKeys } = censusMustBeClosed('workbench:relief-palette')
      // docked as one column beside the rail, the height map a section in it (Form stage 51; both floated before):
      // nothing of it floats, and the map is there
      expect(floatingKeys.filter((k) => k.includes('ReliefPanel'))).toEqual([])
      expect(document.querySelector('[data-testid="relief-palette-shell"] [data-testid="relief-map-shell"]')).not.toBeNull()
    } finally {
      ctx.mockRestore()
      useReliefStore.getState().closeSession()
    }
  })

  it('the Fillet bottom command strip in its refusal state', async () => {
    const { FilletDialog } = await import('../../components/model3d/dialogs/FilletDialog')
    const { CommandHistory, FeatureDag } = await import('../../doc')
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    render(
      <FilletDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        edgeIds={['edge-1']}
        previewState={{ status: 'refused', message: 'Preview refused for census' }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('workbench:fillet-command-strip-refusal')
    expect(floatingKeys).toContain(
      'components/model3d/dialogs/FilletDialog.tsx:FilletDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay',
    )
  })

  it('the Chamfer bottom command strip in its refusal state', async () => {
    const { ChamferDialog } = await import('../../components/model3d/dialogs/ChamferDialog')
    const { CommandHistory, FeatureDag } = await import('../../doc')
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    render(
      <ChamferDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        edgeIds={['edge-1']}
        previewState={{ status: 'refused', message: 'Preview refused for census' }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('workbench:chamfer-command-strip-refusal')
    expect(floatingKeys).toContain(
      'components/model3d/dialogs/ChamferDialog.tsx:ChamferDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay',
    )
  })

  it('the Shell bottom command strip in its refusal state', async () => {
    const { ShellDialog } = await import('../../components/model3d/dialogs/ShellDialog')
    const { CommandHistory, FeatureDag } = await import('../../doc')
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    render(
      <ShellDialog
        dag={dag}
        history={history}
        mode="create"
        ownerId="F1"
        faceIds={['face-1']}
        previewState={{ status: 'refused', message: 'Preview refused for census' }}
        onApplied={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('workbench:shell-command-strip-refusal')
    expect(floatingKeys).toContain(
      'components/model3d/dialogs/ShellDialog.tsx:ShellDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay',
    )
  })

  it('the Seat in vise workspace strip (WO-1586), in its refusal state', async () => {
    const { SeatInViseStrip, useSeatInViseUi } = await import('../../components/viewport/SeatInViseStrip')
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({
        project: {
          ...s.project,
          geometry: [
            {
              id: 'census-vise', name: 'Vise', type: 'mesh', format: 'stl', loaded: true, workholding: true,
              position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
              boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
            },
            {
              id: 'census-part', name: 'Part', type: 'mesh', format: 'stl', loaded: true,
              position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
              boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
            },
          ],
        },
      } as never)
    })
    // WO-1587 moved the strip's markup out of the mounted-nowhere modal into
    // the viewport component Viewport.tsx really renders, so the mount is now
    // the strip plus its open signal (the cross-component store the Properties
    // panel's Workholding row writes) rather than an `open` prop. Opening
    // BEFORE the render is what preselects the workholding body: the gate
    // component mounts the body fresh, and the body reads its initial
    // workholding id once, on mount.
    act(() => { useSeatInViseUi.getState().openSeatInVise('census-vise') })
    render(<SeatInViseStrip />)
    // Drive it to the refusal state (an X-normal face on both sides of the
    // second pick is parallel to the jaw contact, workholdingSeat.ts's own
    // refusal) so the census sees the SAME element the refusal modifier class
    // adds, matching the Fillet/Chamfer/Shell recipes' own refusal-state mounts.
    fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'census-part' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))
    fireEvent.change(screen.getByTestId('seat-in-vise-hold-face'), { target: { value: 'px' } })
    fireEvent.change(screen.getByTestId('seat-in-vise-part-face'), { target: { value: 'px' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))
    expect(screen.getByTestId('seat-in-vise-error'), 'recipe stale: the refusal branch was not reached').toBeTruthy()

    const { floatingKeys } = censusMustBeClosed('workbench:seat-in-vise-strip-refusal')
    // The open signal lives in a module-level store that resetStore() does not
    // reach, so close it here -- before the assertion, so a red one still hands
    // the next recipe a clean viewport rather than a strip nobody mounted.
    act(() => { useSeatInViseUi.getState().closeSeatInVise() })
    expect(floatingKeys).toContain(
      'components/viewport/SeatInViseStrip.tsx:SeatInViseStripBody > div.seat-in-vise-strip.seat-in-vise-strip--refusal.sketch-confirm-overlay',
    )
  })
})

describe('WO-2305 / independent 2D reference image editor', () => {
  beforeEach(resetStore)
  it('censuses the real image panel after inserting a project-owned underlay', async () => {
    const { ReferenceImage2dControls, referenceImage2dUi } = await import('../../components/panels/sketch/ReferenceImage2d')
    act(() => {
      useCamStore.getState().insertReferenceImage2d({ id: 'census:2d-image', payload: {
        datumType: 'reference-image', name: 'Ruler.png', planeNodeId: 'cam:xy',
        image: { dataUrl: 'data:image/png;base64,AQID', fileName: 'Ruler.png', widthPx: 400, heightPx: 200 },
        widthMm: 100, heightMm: 50, opacity: 0.5,
      } })
      referenceImage2dUi.setState({ id: 'census:2d-image' })
    })
    render(<ReferenceImage2dControls />)
    const { floatingKeys } = censusMustBeClosed('sketch:reference-image-editor')
    expect(floatingKeys).toContain('components/panels/sketch/ReferenceImage2d.tsx:ReferenceImage2dControls > aside.reference-image2d-controls')
    act(() => { referenceImage2dUi.setState({ id: null, calibrating: false }) })
  })
})

describe('WO-2318 / shared sketch import and export windows', () => {
  beforeEach(resetStore)
  it.each(['Import...', 'Export / Print...'])('censuses the real row with %s open', async (name) => {
    const { ImportIntoSketchRow } = await import('../../components/panels/sketch/SketchToolbox')
    render(<ImportIntoSketchRow />)
    fireEvent.click(screen.getByRole('button', { name }))
    const { floatingKeys } = censusMustBeClosed(`sketch:${name}`)
    expect(floatingKeys).toContain('components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > div.modal-backdrop')
  })
})

describe('MACHINE-CONTROL / 2g. recipe: the Control tab machine surfaces', () => {
  beforeEach(resetStore)

  it('MachineActionsModal open renders the shared modal backdrop', async () => {
    const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
    render(<MachineActionsModal open onClose={() => {}} />)
    const { floatingKeys } = censusMustBeClosed('machine:actions-modal')
    expect(
      floatingKeys,
      'MachineActionsModal open did not render its backdrop -- recipe stale',
    ).toContain('components/machine/MachineActionsModal.tsx:MachineActionsModal > div.modal-backdrop')
  })

  it('MacroEditor open renders the shared modal backdrop (WO-1706)', async () => {
    const { MacroEditor } = await import('../../components/machine/MacroEditor')
    render(<MacroEditor open onClose={() => {}} />)
    const { floatingKeys } = censusMustBeClosed('machine:macro-editor')
    expect(
      floatingKeys,
      'MacroEditor open did not render its backdrop -- recipe stale',
    ).toContain('components/machine/MacroEditor.tsx:MacroEditor > div.modal-backdrop')
  })

  it('MeshViewerModal opened via openModal(\'mesh-viewer\') renders the shared modal backdrop (WO-416)', async () => {
    // WO-416: the flatness viewer opened from the "Mesh N x N" chip that
    // replaced the full-width "MESH COMPENSATION ACTIVE" banner. Mounted with
    // a real active surface mesh so the readouts (the whole point of the
    // modal) are proven live, not just the empty state.
    const { MeshViewerModal } = await import('../../components/machine/MeshViewerModal')
    const { useMachineControl } = await import('../../store/machineControlStore')
    const { buildSurfaceMeshPoints } = await import('../../lib/machine/zSurfaceMesh')
    const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 }
    const points = buildSurfaceMeshPoints(bounds, 3, 3)
    const samples = points.map((point, index) => ({ ...point, machineZ: -50 + index * 0.01 }))
    const beforeMesh = useMachineControl.getState().surfaceMesh
    act(() => {
      useMachineControl.setState({
        surfaceMesh: {
          bounds, cutBounds: bounds, pointsX: 3, pointsY: 3, fadeMm: 10,
          referenceMachineZ: samples[0].machineZ, samples,
          sourceFingerprint: 'census-fingerprint', sourceName: 'census.nc',
          workOffset: 'G54', probedAt: 1, active: true,
        },
      })
    })
    act(() => { useCamStore.getState().openModal('mesh-viewer') })
    try {
      render(<MeshViewerModal />)
      // WO-2622: metric machine readouts use the shared two-decimal length
      // format. Keep the exact sample value and unit check before the census.
      expect(screen.getByTestId('mesh-viewer-min-z').textContent).toBe('-50.00 mm')
      const { floatingKeys } = censusMustBeClosed('machine:mesh-viewer-modal')
      expect(
        floatingKeys,
        'MeshViewerModal open did not render its backdrop -- recipe stale',
      ).toContain('components/machine/MeshViewerModal.tsx:MeshViewerModal > div.modal-backdrop')
    } finally {
      act(() => { useMachineControl.setState({ surfaceMesh: beforeMesh }) })
    }
  })

  it('ProgramPreview renders its empty-state hint over the 3D host', async () => {
    // MC-TIER1: the authored Canvas-2D backplot is GONE. ProgramPreview now
    // mounts a CNCViewport, whose canvas is appended by THREE at runtime, so
    // the only authored floating surface left here is the empty-state hint.
    const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
    render(<ProgramPreview />)
    const { floatingKeys } = censusMustBeClosed('machine:program-preview')
    expect(floatingKeys, 'ProgramPreview empty state missing -- recipe stale').toContain(
      'components/machine/ProgramPreview.tsx:ProgramPreview > div.control-preview-empty.panel-empty',
    )
  })

  it('ProgramPreview renders the intended-stock line once a program is loaded, and its facts popover when the line is clicked (WO-380 / WO-414 batch 2)', async () => {
    // WO-380: the readout rides on the preview whenever a program is loaded -
    // here the no-context state (a file with no setup snapshot), which is the
    // same authoring site the current and stale states render through.
    // WO-414 batch 2: it is ONE line lower-right; clicking it opens the facts
    // as a popover above the line (a second, in-place positioned surface).
    const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
    const { useMachineControl } = await import('../../store/machineControlStore')
    const before = useMachineControl.getState().job
    act(() => {
      useMachineControl.setState({ programContext: null, job: { ...before, name: 'foreign.nc' } })
    })
    try {
      render(<ProgramPreview />)
      fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
      const { floatingKeys } = censusMustBeClosed('machine:program-preview-intended-stock')
      expect(floatingKeys, 'ProgramPreview intended-stock line missing -- recipe stale').toContain(
        'components/machine/ProgramPreview.tsx:IntendedStockReadout > div.control-intended-stock-card.control-overlay-bottom-right.control-overlay-card',
      )
      expect(floatingKeys, 'ProgramPreview intended-stock popover missing -- recipe stale').toContain(
        'components/machine/ProgramPreview.tsx:IntendedStockReadout > div.control-intended-stock-popover',
      )
    } finally {
      act(() => { useMachineControl.setState({ job: before }) })
    }
  })

  it('ProgramPreview renders the travel-mismatch line when the controller disagrees with the Machine Library (WO-292 / WO-414 batch 2)', async () => {
    const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
    const { useMachineControl } = await import('../../store/machineControlStore')
    const machineBefore = useCamStore.getState().project.machine
    const ctlBefore = { settings: useMachineControl.getState().settings, connectionPhase: useMachineControl.getState().connectionPhase, connectionKind: useMachineControl.getState().connectionKind }
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, machine: { ...s.project.machine, travel: { x: 738, y: 724.5, z: 128.9 } } } }))
      useMachineControl.setState({ connectionPhase: 'connected', connectionKind: 'serial', settings: { 130: '700.000', 131: '724.500', 132: '128.900' } })
    })
    try {
      render(<ProgramPreview />)
      const { floatingKeys } = censusMustBeClosed('machine:program-preview-travel-mismatch')
      expect(floatingKeys, 'ProgramPreview travel-mismatch line missing -- recipe stale').toContain(
        'components/machine/ProgramPreview.tsx:TravelMismatchLine > div.control-overlay-bottom.control-overlay-card.control-travel-mismatch',
      )
    } finally {
      act(() => {
        useCamStore.setState((s) => ({ project: { ...s.project, machine: machineBefore } }))
        useMachineControl.setState(ctlBefore)
      })
    }
  })

  it('PendantPanel opens its pairing flyout beside the Pendant button (Operator ruling 2026-08-20, WO-404)', async () => {
    const { PendantPanel } = await import('../../components/machine/PendantPanel')
    render(<PendantPanel />)
    fireEvent.click(screen.getByTestId('pendant-status-button'))
    const { floatingKeys } = censusMustBeClosed('machine:pendant-flyout')
    expect(floatingKeys, 'pendant pairing flyout missing -- recipe stale').toContain(
      'components/machine/PendantPanel.tsx:PendantPanel > div.pendant-popover',
    )
  })

  it('ProgramPanel renders the failed guided-tool-change card over its preview', async () => {
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { useMachineControl } = await import('../../store/machineControlStore')
    act(() => {
      useMachineControl.setState({
        connectionPhase: 'connected',
        machineState: 'idle',
        fitTrace: null,
        toolChange: {
          step: 'failed',
          mode: 'toolChange',
          tool: 2,
          resumeLine: 5,
          message: 'Probe did not make contact.',
          warnings: [],
        },
      })
    })
    render(<ProgramPanel />)
    const { floatingKeys } = censusMustBeClosed('machine:program-toolchange-failed')
    expect(floatingKeys).toContain(
      'components/machine/ProgramPanel.tsx:ProgramPanel > div.control-overlay-card.control-overlay-top.control-tc-failed.control-toolchange-banner',
    )
  })

  it('ProgramPanel renders the failed material-fit-trace card over its preview', async () => {
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { useMachineControl } = await import('../../store/machineControlStore')
    act(() => {
      useMachineControl.setState({
        connectionPhase: 'connected',
        machineState: 'idle',
        toolChange: null,
        fitTrace: {
          step: 'failed',
          message: 'Material fit trace stopped.',
          bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
          lines: [],
        },
      })
    })
    render(<ProgramPanel />)
    const { floatingKeys } = censusMustBeClosed('machine:program-fit-trace-failed')
    expect(floatingKeys).toContain(
      'components/machine/ProgramPanel.tsx:ProgramPanel > div.control-overlay-card.control-overlay-top.control-tc-failed.control-toolchange-banner#2',
    )
  })
})

describe('WO UI-70-R3 / 2e. recipe: the CAM modal backdrops', () => {
  beforeEach(resetStore)

  // A2 names FOUR exemption mechanisms and 'modal-governed' is not among them:
  // these mount fine in jsdom, so they must be OBSERVED. They take zero props
  // and self-gate on the store, and they reach the viewport only through
  // getVp()?.x?.() -- a silent no-op here -- so no mock is needed for any of
  // them. Mounted CLOSED first, then opened, so the census reads a true
  // closed->open transition rather than a component born open.
  const MODALS: ReadonlyArray<{ id: string; module: string; export: string; key: string }> = [
    { id: 'machine-config', module: '../../components/modals/MachineLibraryModal', export: 'MachineLibraryModal', key: 'components/modals/MachineLibraryModal.tsx:MachineLibraryModal > div.modal-backdrop' },
    { id: 'model-entry', module: '../../components/modals/ModelEntryModal', export: 'ModelEntryModal', key: 'components/modals/ModelEntryModal.tsx:ModelEntryModal > div.modal-backdrop' },
    // MSH-4-BOOLEAN-EDIT: the boolean-mesh dialog is a fixed floating side panel
    // (no backdrop); its outer div is the observed surface (key from the cohesion
    // census). openModal('boolean-mesh') opens it (same gate as openBooleanMeshDialog).
    { id: 'boolean-mesh', module: '../../components/modals/BooleanMeshDialog', export: 'BooleanMeshDialog', key: 'components/modals/BooleanMeshDialog.tsx:BooleanMeshDialog > div' },
    { id: 'new-nest', module: '../../components/modals/NestModal', export: 'NestModal', key: 'components/modals/NestModal.tsx:NestModal > div.modal-backdrop' },
    // Ordinary create/edit open lands on the "Full modal render" return, the
    // SECOND div.modal-backdrop authoring site in source order -- key #2 (see
    // the editLoadError-branch recipe above for the bare key's own coverage).
    { id: 'new-operation', module: '../../components/modals/NewOperationModal', export: 'NewOperationModal', key: 'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.modal-backdrop#2' },
    { id: 'post-process', module: '../../components/modals/PostProcessModal', export: 'PostProcessModal', key: 'components/modals/PostProcessModal.tsx:PostProcessModal > div.modal-backdrop' },
    { id: 'settings', module: '../../components/modals/SettingsModal', export: 'SettingsModal', key: 'components/modals/SettingsModal.tsx:SettingsModal > div.modal-backdrop' },
    { id: 'sketch-entry', module: '../../components/modals/SketchEntryModal', export: 'SketchEntryModal', key: 'components/modals/SketchEntryModal.tsx:SketchEntryModal > div.modal-backdrop' },
    { id: 'tool-library', module: '../../components/modals/ToolLibraryModal', export: 'ToolLibraryModal', key: 'components/modals/ToolLibraryModal.tsx:ToolLibraryModal > div.modal-backdrop' },
    { id: 'help', module: '../../components/modals/HelpCenterModal', export: 'HelpCenterModal', key: 'components/modals/HelpCenterModal.tsx:HelpCenterModal > div.modal-backdrop' },
  ]

  for (const m of MODALS) {
    it(`${m.export} opened via openModal('${m.id}')`, async () => {
      const mod = await import(/* @vite-ignore */ m.module) as Record<string, React.ComponentType>
      const Modal = mod[m.export]
      // NewOperationModal early-returns without a setup; seeding one for every
      // modal is harmless and keeps the recipe uniform.
      seedSetupWithLoops()
      render(<Modal />)
      act(() => { useCamStore.getState().openModal(m.id) })
      const { floatingKeys } = censusMustBeClosed(`modal:${m.id}`)
      // Non-vacuity per recipe: the modal must actually have OPENED. Every one
      // of these self-gates and returns null when closed, so a stale id would
      // render nothing and sail through a fail-closed assertion.
      expect(floatingKeys, `openModal('${m.id}') did not render ${m.export} -- recipe stale`).toContain(m.key)
    })
  }

  it('ThemedListbox: opening a Settings custom select renders its fixed dropdown (a real click)', async () => {
    // The themed custom-select popup (UI-BRAND-B3-1, Q-65) only exists in the
    // DOM once its trigger is opened. Open Settings, click a listbox trigger,
    // and OBSERVE the position:fixed dropdown live so its COHESIVE disposition
    // is watched render (amendment A2, direction two) rather than a written
    // opinion. Same closed->open transition every modal recipe above uses.
    const { SettingsModal } = await import('../../components/modals/SettingsModal')
    render(<SettingsModal />)
    act(() => { useCamStore.getState().openModal('settings') })
    const trigger = document.querySelector('[data-testid="settings-display-units"]')
    expect(trigger, 'the Settings display-units listbox trigger is missing -- recipe stale').not.toBeNull()
    act(() => { fireEvent.click(trigger as Element) })
    const { floatingKeys } = censusMustBeClosed('themed-listbox:settings-display-units')
    expect(
      floatingKeys,
      'the ThemedListbox dropdown did not render on open -- recipe stale',
    ).toContain('components/ui/ThemedListbox.tsx:ThemedListbox > ul.themed-listbox-popup')
  })

  it('ThemedTooltip: focusing a data-tooltip control renders the shared fixed hint (a11y focus path)', async () => {
    // The shared themed tooltip (B3-2, Q-65) only exists in the DOM while a
    // tipped control is hovered or FOCUSED (the keyboard a11y path). Mount the
    // singleton + a tipped control, focus it, and OBSERVE the position:fixed
    // hint live so its COHESIVE disposition is watched render (amendment A2,
    // direction two) rather than a written opinion.
    const { ThemedTooltip } = await import('../../components/ui/ThemedTooltip')
    render(
      <>
        <button data-tooltip="Toggle stock" data-testid="tt-target">stock</button>
        <ThemedTooltip />
      </>,
    )
    const target = document.querySelector('[data-testid="tt-target"]')
    expect(target, 'the tipped control is missing -- recipe stale').not.toBeNull()
    // ThemedTooltip intentionally treats only :focus-visible as keyboard
    // focus. jsdom does not derive that modality, so drive the same explicit
    // focus-visible path as src/tests/components/ThemedTooltip.test.tsx.
    vi.spyOn(target as HTMLElement, 'matches').mockImplementation((selector) => (
      selector === ':focus-visible'
        ? true
        : Element.prototype.matches.call(target, selector)
    ))
    act(() => { fireEvent.focusIn(target as Element) })
    const { floatingKeys } = censusMustBeClosed('themed-tooltip:focus')
    expect(
      floatingKeys,
      'the ThemedTooltip hint did not render on focus -- recipe stale',
    ).toContain('components/ui/ThemedTooltip.tsx:ThemedTooltip > div.themed-tooltip')
  })

  it('ConfirmModal: requestConfirm renders the themed confirm backdrop (PROMOTE-SKETCH-FAIL round 2)', async () => {
    // The themed confirm (the on-brand replacement for native window.confirm)
    // is store-driven via requestConfirm/confirmDialog rather than openModal,
    // so it needs its own closed->open recipe. Mount it CLOSED, fire a confirm
    // request, and OBSERVE the position:fixed .modal-backdrop live so its
    // MODAL-GOVERNED disposition is watched render (amendment A2, direction two)
    // rather than a written opinion.
    const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
    render(<ConfirmModal />)
    act(() => { void useCamStore.getState().requestConfirm({ title: 'Convert sketch to model?', body: 'x' }) })
    const { floatingKeys } = censusMustBeClosed('confirm:requestConfirm')
    expect(
      floatingKeys,
      'requestConfirm did not render ConfirmModal -- recipe stale',
    ).toContain('components/modals/ConfirmModal.tsx:ConfirmModal > div.modal-backdrop')
    // Resolve it so the module-level resolver never leaks into a later test.
    act(() => { useCamStore.getState().resolveConfirm(false) })
  })

  it('HelpFigure: clicking a help figure renders the maximize lightbox + its X close (Operator directive, 5eae1d577)', async () => {
    // The help-image lightbox is component-local state (no store), so its two
    // fixed surfaces need their own closed->open recipe: mount a figure,
    // click it, and OBSERVE the lightbox scrim and close button live so both
    // MODAL-GOVERNED dispositions are watched renders, not written opinions.
    const { HelpFigure } = await import('../../components/modals/HelpFigure')
    render(<HelpFigure src="/help/x/y.webp" alt="proof figure" />)
    fireEvent.click(screen.getByRole('button', { name: /proof figure/i }))
    const { floatingKeys } = censusMustBeClosed('help:figure-lightbox')
    expect(
      floatingKeys,
      'clicking the figure did not render the lightbox -- recipe stale',
    ).toContain('components/modals/HelpFigure.tsx:HelpFigure > div.help-image-lightbox')
    expect(
      floatingKeys,
      'the lightbox rendered without its X close button -- recipe stale',
    ).toContain('components/modals/HelpFigure.tsx:HelpFigure > button.help-image-lightbox-close')
    // Close it so the fixed scrim never leaks into a later recipe.
    fireEvent.keyDown(window, { key: 'Escape' })
  })

  it('MultiBodyImportModal: requestMultiBodyImportChoice renders the themed choice backdrop (IMPORT-MULTIBODY-CHOICE Q-76)', async () => {
    // The multi-body STEP import chooser (Operator Q-76: the user decides one item
    // vs one item per body) is store-driven via requestMultiBodyImportChoice/
    // multiBodyImportChoice rather than openModal, so it needs its own
    // closed->open recipe like ConfirmModal. Mount CLOSED, fire the request, and
    // OBSERVE the position:fixed .modal-backdrop live so its MODAL-GOVERNED
    // disposition is watched render (amendment A2, direction two).
    const { MultiBodyImportModal } = await import('../../components/modals/MultiBodyImportModal')
    render(<MultiBodyImportModal />)
    act(() => {
      void useCamStore.getState().requestMultiBodyImportChoice({
        geoId: 'census-geo', name: 'census-multibody.step', bodyCount: 3, currentMode: 'combined',
      })
    })
    const { floatingKeys } = censusMustBeClosed('multibody-import:requestChoice')
    expect(
      floatingKeys,
      'requestMultiBodyImportChoice did not render MultiBodyImportModal -- recipe stale',
    ).toContain('components/modals/MultiBodyImportModal.tsx:MultiBodyImportModal > div.modal-backdrop')
    // Resolve it so the module-level resolver never leaks into a later test.
    act(() => { useCamStore.getState().resolveMultiBodyImportChoice('combined') })
  })

  it('ImportStockChoiceModal: requestImportStockChoice renders the themed choice backdrop (IMPORT-STOCK-PROMPT)', async () => {
    // The import-time stock chooser (IMPORT-STOCK-PROMPT: the user picks which
    // stock a new part joins) is store-driven via requestImportStockChoice/
    // importStockChoice rather than openModal, so it needs its own closed->open
    // recipe like MultiBodyImportModal. Mount CLOSED, seed an explicit stock so
    // the request opens (rather than returning null for "no obvious stock"),
    // fire the request, and OBSERVE the position:fixed .modal-backdrop live so
    // its MODAL-GOVERNED disposition is watched render (amendment A2, dir two).
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        stocks: [{
          id: 'census-fix', name: 'Census Fixture', mode: 'explicit' as const,
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 10 },
            size: { x: 50, y: 50, z: 10 }, center: { x: 25, y: 25, z: 5 } },
          position: { x: 0, y: 0, z: 0 },
        }],
        geometry: [{
          id: 'census-geo', name: 'Census Part', filename: 'census-part.stl',
          type: 'mesh' as const, format: 'stl' as const,
          boundingBox: {
            min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
            size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
          },
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          loaded: true,
        }],
      },
    }))
    const { ImportStockChoiceModal } = await import('../../components/modals/ImportStockChoiceModal')
    render(<ImportStockChoiceModal />)
    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'census-geo', name: 'census-part.stl' })
    })
    const { floatingKeys } = censusMustBeClosed('import-stock-choice:requestChoice')
    expect(
      floatingKeys,
      'requestImportStockChoice did not render ImportStockChoiceModal -- recipe stale',
    ).toContain('components/modals/ImportStockChoiceModal.tsx:ImportStockChoiceModal > div.modal-backdrop')
    // Resolve it so the module-level resolver never leaks into a later test.
    act(() => { useCamStore.getState().resolveImportStockChoice({ kind: 'auto' }) })
  })

  it('NewOperationModal opened via openEditOperation() for a type with no edit UI (editLoadError branch)', async () => {
    // NewOperationModalBody.tsx authors TWO div.modal-backdrop sites in source
    // order: the editLoadError early return (1893, THIS recipe) is textually
    // FIRST so it is the bare key; the ordinary "Full modal render" (1923,
    // every OTHER recipe in this describe block) is textually second, key #2.
    // Without this recipe the bare key's MODAL-GOVERNED disposition is a
    // written opinion nobody has watched render (amendment A2, direction two).
    const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
    seedSetupWithLoops()
    const operation = {
      // Every real operation is wired after WO-1196. Keep this error-path
      // fixture synthetic so the census seat never rotates again.
      id: 'census-unhandled-op', name: 'Census Never Wired', type: NEVER_WIRED_3D, toolId: 'census-missing-tool',
      enabled: true, status: 'ready', geometrySelections: [],
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
      },
      passes: {}, linking: {}, params: {},
    }
    act(() => {
      const s = useCamStore.getState() as unknown as { project: { setups: Array<{ id: string } & Record<string, unknown>> } }
      const setups = s.project.setups.map((setup) =>
        setup.id === CENSUS_SETUP_ID ? { ...setup, operations: [operation] } : setup)
      useCamStore.setState({ project: { ...s.project, setups } } as never)
    })
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(CENSUS_SETUP_ID, 'census-unhandled-op') })
    expect(
      document.querySelector('[data-testid="op-edit-load-error"]'),
      'editLoadError branch did not render -- recipe stale',
    ).not.toBeNull()
    const { floatingKeys } = censusMustBeClosed('modal:new-operation-edit-load-error')
    expect(floatingKeys).toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.modal-backdrop')
  })

  it('NestModal: the part-membership loop-pick banner (the picker AUTO-STARTS once __cncViewport + nestable geometry exist -- UI-61 precedent)', async () => {
    // Same shape as UI-61's committed precedent (NestModalViewportPick.ui61
    // .test.tsx): startPartPicking() early-returns false without a real
    // vp.setPartPickMode, so the recipe stubs window.__cncViewport rather than
    // clicking a button that would be a silent no-op under jsdom.
    const { NestModal } = await import('../../components/modals/NestModal')
    const nestable = {
      id: 'nest-census-part', name: 'Census Bracket', type: 'curves_2d', format: 'svg', loaded: true,
      loops: [{ id: 'outer', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 200 }],
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 0 } },
    }
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({ project: { ...s.project, geometry: [nestable] } } as never)
    })
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setPartPickMode: (_cb: unknown, _eligible: readonly string[] = [], _selected: readonly string[] = []) => {},
      setPartPickSelection: () => {},
    }
    try {
      render(<NestModal />)
      act(() => { useCamStore.getState().openModal('new-nest') })
      expect(
        document.querySelector('[data-testid="nest-part-pick-banner"]'),
        'the picker did not auto-start -- recipe stale',
      ).not.toBeNull()
      const { floatingKeys } = censusMustBeClosed('modal:nest-part-pick-banner')
      expect(floatingKeys).toContain('components/modals/NestModal.tsx:NestModal > div.loop-pick-banner')
    } finally {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    }
  })

  it('SketchEntryModal: the existing-part loop-pick banner (UI-62 precedent)', async () => {
    const { SketchEntryModal } = await import('../../components/modals/SketchEntryModal')
    const geo = {
      id: 'sketch-entry-census-part', name: 'Census Plate', type: 'curves_2d', format: 'dxf', loaded: true,
      loops: [{ id: 'loop', layerId: 'layer-1', closed: true, type: 'contour', area: 100, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
      layers2d: [{ id: 'layer-1', name: 'Profile', color: '#fff', visible: true }],
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 }, size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 } },
    }
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({ project: { ...s.project, geometry: [geo] } } as never)
    })
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setPartPickMode: (_cb: unknown, _allowed: readonly string[] = []) => {},
      setSelectedPart: () => {},
    }
    try {
      render(<SketchEntryModal />)
      act(() => { useCamStore.getState().openModal('sketch-entry') })
      // WO-069: the pick is no longer auto-armed on open -- the modal opens
      // first, and the banner is reached by clicking "Pick existing in
      // viewport".
      expect(
        document.querySelector('[data-testid="sketch-entry-part-pick-banner"]'),
        'the picker auto-started -- recipe stale',
      ).toBeNull()
      act(() => { fireEvent.click(screen.getByTestId('sketch-entry-pick-existing')) })
      expect(
        document.querySelector('[data-testid="sketch-entry-part-pick-banner"]'),
        'the picker did not start after clicking Pick existing -- recipe stale',
      ).not.toBeNull()
      const { floatingKeys } = censusMustBeClosed('modal:sketch-entry-part-pick-banner')
      expect(floatingKeys).toContain('components/modals/SketchEntryModal.tsx:SketchEntryModal > div.loop-pick-banner')
    } finally {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    }
  })

  it('GcodeFlyout: the expanded g-code viewer, reached only through REAL emitted g-code', async () => {
    // The hard one, and the reason it is hard is the reason it matters: the
    // flyout is module-private, reachable only through PostProcessModal, and
    // .post-expand-btn is disabled={!hasGcode} (PostProcessModal.tsx:1384).
    // hasGcode comes from the REAL postProject() over the REAL project -- there
    // is no store flag to flip. So the recipe seeds a setup with an enabled
    // operation carrying toolpathMoves plus the tool it names, and lets the
    // real post run (it is a pure lib and runs fine in jsdom).
    const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
    act(() => {
      const s = useCamStore.getState()
      s.addTool({
        id: 'census-tool', name: 'Census Tool', type: 'flat_end_mill', diameter: 6,
        shankDiameter: 6, overallLength: 50, fluteLength: 18, shoulderLength: 0,
        numberOfFlutes: 2, cornerRadius: 0, angleFromAxisDeg: 59,
        material: 'carbide', coating: 'none', toolNumber: 112, notes: '',
        libraryId: s.toolLibraries[0]?.id ?? 'lib-default',
        feedsAndSpeeds: {
          default: { rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5, stepover: 3, coolant: 'none' },
        },
      } as never)
    })
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown>; toolLibrary: Tool[] }
      // Read the tool BACK from the live store (addTool normalizes cutHand and
      // possibly other fields) -- stampGenerationCurrent's fingerprint must hash
      // the SAME tool object PostProcessModal will actually pass to postProject
      // (it merges { ...project, toolLibrary } from the store's live toolLibrary,
      // PostProcessModal.tsx:288), or the two fingerprints disagree and the op
      // reads right back as OP_OUTDATED.
      const liveTool = s.toolLibrary.find((t) => t.id === 'census-tool')!
      const operation = {
        id: 'census-op', name: 'Census Contour', type: 'contour_2d', toolId: 'census-tool',
        enabled: true, status: 'ready', geometrySelections: [],
        heights: {
          clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
          topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
        },
        passes: {}, linking: {}, params: {},
        toolpathMoves: [
          { type: 'rapid', x: 0, y: 0, z: 10 },
          { type: 'feed', x: 10, y: 0, z: 0, feed: 1000 },
        ],
      }
      const setup = { id: CENSUS_SETUP_ID, name: 'Census Setup', wcs: CENSUS_WCS, stock: null, notes: '', operations: [operation] }
      const project = { ...s.project, setups: [setup], activeSetupId: CENSUS_SETUP_ID }
      // CAM-15 (52ac9e3e7, stampGenerationCurrent added d1f1b2bc4): without this,
      // buildPostInput's operationGenerationIsCurrent gate downgrades the op to
      // OP_OUTDATED and postProject() emits no g-code -- the flyout's opener
      // (.post-expand-btn) stays disabled and the recipe cannot reach it.
      stampGenerationCurrent(
        { ...project, toolLibrary: s.toolLibrary } as unknown as Project,
        setup as unknown as Setup,
        operation as unknown as Operation,
        liveTool,
      )
      useCamStore.setState({ project } as never)
    })
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    const expand = document.querySelector('.post-expand-btn') as HTMLButtonElement | null
    expect(expand, 'the .post-expand-btn is the flyout\'s only opener -- recipe stale').not.toBeNull()
    // Non-vacuity, stated: if the real post emitted nothing this button is
    // DISABLED, the click is a no-op, and the recipe would "pass" having
    // rendered no flyout at all.
    expect(expand?.disabled, 'postProject() emitted no g-code, so the flyout is unreachable -- the seed is wrong, '
      + 'and clicking a disabled button would have proved nothing').toBe(false)
    fireEvent.click(expand as Element)
    const { floatingKeys } = censusMustBeClosed('modal:post-process-gcode-flyout')
    expect(floatingKeys).toContain('components/modals/PostProcessModal.tsx:GcodeFlyout > div.gcode-flyout-backdrop')
  })

  it('MachineChoiceModal -- the exception: it gates on machineChoiceRequired, not activeModal', async () => {
    const { MachineChoiceModal } = await import('../../components/modals/MachineChoiceModal')
    render(<MachineChoiceModal />)
    act(() => {
      useCamStore.setState((s) => ({
        machineChoiceRequired: true,
        machineLibrary: [{
          id: 'census-machine', name: 'Census Machine', type: 'gantry_router', controller: 'grbl',
          travel: { x: 100, y: 100, z: 50 }, rapidRate: 5000,
          maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
          toolChanger: 'manual', coolant: false, notes: '',
        }] as ReturnType<typeof useCamStore.getState>['machineLibrary'],
        appSettings: { ...s.appSettings, defaultMachineId: 'census-machine' },
      }))
    })
    const { floatingKeys } = censusMustBeClosed('modal:machine-choice')
    expect(floatingKeys).toContain('components/modals/MachineChoiceModal.tsx:MachineChoiceModal > div.modal-backdrop')
    act(() => { useCamStore.setState({ machineChoiceRequired: false }) })
  })
})

describe('WO UI-70-R3 / 2f. recipe: SetupModal -- one mount per STATE, because the states exclude each other', () => {
  beforeEach(resetStore)

  it('stock-corner-pick mode: the FIRST vertex-pick-banner authoring site (UI-63 precedent)', async () => {
    // handleStartStockCornerPick early-returns before setIsPickingStockCorner
    // without a real vp.enterStockCornerPickMode AND a rendered stock (getBounds
    // resolving non-null) -- same shape as UI-63's committed precedent
    // (SetupModalStockCornerPick.ui63.test.tsx), so the recipe stubs
    // window.__cncViewport rather than reaching into React state.
    const { SetupModal } = await import('../../components/modals/SetupModal')
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          stocks: [{
            id: 'stock-a', name: 'Stock A', mode: 'explicit',
            bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 12 }, size: { x: 100, y: 50, z: 12 }, center: { x: 50, y: 25, z: 6 } },
            position: { x: 0, y: 0, z: 0 },
          }] as unknown as typeof state.project.stocks,
          setups: [],
        },
      }))
    })
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 12 } }),
      setWCSOrigin: () => {},
      enterStockCornerPickMode: () => {},
      exitStockCornerPickMode: () => {},
      exitWCSGizmoMode: () => {},
      exitVertexPickMode: () => {},
    }
    try {
      render(<SetupModal />)
      act(() => { useCamStore.getState().openModal('new-setup') })
      const pickBtn = document.querySelector('[data-testid="setup-pick-stock-corner"]')
      expect(pickBtn, 'the setup-pick-stock-corner button -- recipe stale').not.toBeNull()
      fireEvent.click(pickBtn as Element)
      const { floatingKeys } = censusMustBeClosed('setup-modal:stock-corner-pick')
      expect(floatingKeys).toContain('components/modals/SetupModal.tsx:SetupModal > div.vertex-pick-banner')
    } finally {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    }
  })

  it('gizmo mode: the transparent backdrop AND the compact container, from ONE real click', async () => {
    // Both surfaces come from the same conditional (SetupModal.tsx:426 and :429
    // both key off `gizmoMode`), so one state drives both. The Gizmo tab is a
    // real button clicked for real -- not setOriginMode reached into.
    const { SetupModal } = await import('../../components/modals/SetupModal')
    seedSetupWithLoops()
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    const gizmoTab = Array.from(document.querySelectorAll('.wcs-tab'))
      .find((b) => (b.textContent ?? '').includes('Gizmo'))
    expect(gizmoTab, 'the Gizmo wcs-tab is the only way into gizmo mode -- recipe stale').not.toBeUndefined()
    fireEvent.click(gizmoTab as Element)
    const { floatingKeys } = censusMustBeClosed('setup-modal:gizmo')
    expect(floatingKeys).toContain('components/modals/SetupModal.tsx:SetupModal > div.modal-backdrop.modal-backdrop-transparent')
    expect(floatingKeys).toContain('components/modals/SetupModal.tsx:SetupModal > div.modal-container.setup-modal.setup-modal-compact')
  })

  it('THE STALE-FIBER MISATTRIBUTION, constructed and refused (WO UI-70-R3)', async () => {
    // WORKER-CHARTER item 4: an ordering/staleness claim is settled by a
    // CONSTRUCTED interleave committed to the tree, never by prose about the
    // reconciler. The claim: React does not refresh `fiber._debugStack` on an
    // update (createWorkInProgress copies it, react-dom-client.development.js:
    // 4819; updateElement refreshes _debugOwner and _debugInfo but not the
    // stack, :6268), so R2's site attribution named a REUSED fiber by the site
    // that FIRST created it.
    //
    // This is that exact interleave: SetupModal renders div.modal-backdrop at
    // :679, then early-returns div.vertex-pick-banner (the SECOND authoring
    // site, isPickingVertex's WCS-origin snap variant) at :662 in
    // its place.
    // Same position, same tag -> React reuses the fiber. Both answers are read
    // off the SAME live element and asserted to DISAGREE.
    //
    // Why it is a bypass and not a mislabel: the stale site is a DISPOSITIONED
    // one, so the banner inherited the backdrop's disposition and the
    // fail-closed direction passed it silently. R2's safety argument is "a
    // surface the static walk cannot name is still SEEN, finds no name, and
    // fails BY NAME" -- a stale site does not fail to find a name, it finds the
    // WRONG one. Found by the completeness direction this round, because the
    // banner's own key was never observed while a green census claimed it was.
    const { SetupModal } = await import('../../components/modals/SetupModal')
    seedSetupWithLoops()
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    expect(document.querySelector('.modal-backdrop'), 'the backdrop must render FIRST, or no fiber is reused').not.toBeNull()
    const snapTab = Array.from(document.querySelectorAll('.wcs-tab')).find((b) => (b.textContent ?? '').includes('Snap'))
    fireEvent.click(snapTab as Element)
    fireEvent.click(document.querySelector('.wcs-snap-btn') as Element)

    const banner = document.querySelector('.vertex-pick-banner')
    expect(banner, 'the banner must have replaced the backdrop in the same slot').not.toBeNull()
    const fiber = Object.keys(banner as object).filter((k) => k.startsWith('__reactFiber$'))
      .map((k) => (banner as unknown as Record<string, unknown>)[k])[0]
    expect(fiber, 'no fiber on the banner -- this test can prove nothing').not.toBeUndefined()

    // R2's answer: the site React's _debugStack still reports.
    const stale = staleFiberSiteOf(fiber as Parameters<typeof staleFiberSiteOf>[0])
    // R3's answer: the site the element itself carries, written by the render
    // that is actually on screen.
    const live = siteOfElement(banner as Element)

    expect(live, 'the live element must name its OWN site').not.toBeNull()
    // SETUP-GRID-UNCOLLAPSE (2026-07-24) removed the <details> disclosure
    // Coordinates are diagnostics, not identity. Assert the stable authoring
    // keys below instead of pinning line numbers that drift after unrelated
    // inserts above these unchanged JSX sites.
    expect(live?.file).toBe('components/modals/SetupModal.tsx')
    expect(stale?.file).toBe('components/modals/SetupModal.tsx')
    expect(stale?.line, 'the whole point: the two answers DISAGREE on a real production component').not.toBe(live?.line)

    // And the consequence, pinned: the stale site resolves to a DIFFERENT,
    // already-dispositioned authoring key. That is the silent pass.
    const staleKey = keyMap.bySite.get(`${stale?.file}@${stale?.line}:${stale?.column}`)?.authoringKey
    const liveKey = keyMap.bySite.get(`${live?.file}@${live?.line}:${live?.column}`)?.authoringKey
    expect(staleKey).toBe('components/modals/SetupModal.tsx:SetupModal > div.modal-backdrop.modal-backdrop-transparent')
    expect(liveKey).toBe('components/modals/SetupModal.tsx:SetupModal > div.vertex-pick-banner#2')
    expect(dispositionFor(staleKey as string), 'the stale key IS dispositioned -- which is why the mislabel passed').not.toBeUndefined()
  })

  it('vertex-pick mode: the banner that REPLACES the modal (a separate mount by construction)', async () => {
    // CAUTION, and the reason this is its own recipe: the banner is an EARLY
    // RETURN (SetupModal.tsx:501-513, the WCS-origin snap variant -- the SECOND
    // vertex-pick-banner authoring site) that returns INSTEAD of the backdrop.
    // The two can never coexist, so "one mount per component" is not available
    // here -- it is one mount per state.
    const { SetupModal } = await import('../../components/modals/SetupModal')
    seedSetupWithLoops()
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    const snapTab = Array.from(document.querySelectorAll('.wcs-tab'))
      .find((b) => (b.textContent ?? '').includes('Snap'))
    expect(snapTab, 'the Snap wcs-tab -- recipe stale').not.toBeUndefined()
    fireEvent.click(snapTab as Element)
    const snapBtn = document.querySelector('.wcs-snap-btn')
    expect(snapBtn, 'the .wcs-snap-btn starts the vertex pick (SetupModal.tsx:715, handleStartVertexPick) -- recipe stale').not.toBeNull()
    fireEvent.click(snapBtn as Element)
    const { floatingKeys } = censusMustBeClosed('setup-modal:vertex-pick')
    expect(floatingKeys).toContain('components/modals/SetupModal.tsx:SetupModal > div.vertex-pick-banner#2')
    // The early return is real: the backdrop is GONE, not merely covered. Pinned
    // so a refactor that made them coexist would be noticed here.
    expect(floatingKeys).not.toContain('components/modals/SetupModal.tsx:SetupModal > div.modal-backdrop')
  })
})

describe('WO UI-70-R3 / 2g. recipe: NewOperationModal\'s loop-pick banners (three, plus a FOURTH source-part-pick site added independently)', () => {
  beforeEach(resetStore)

  // All FOUR are EARLY RETURNS preceding the backdrop, driven by local state
  // through real DOM clicks.
  async function openNewOperation() {
    const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
    seedSetupWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
  }

  it('the source-part-pick banner (bare key, the FIRST loop-pick-banner authoring site -- UI-60 precedent)', async () => {
    // startSourcePartPicking sets state unconditionally (no vp gate), but the
    // callback that RESOLVES a pick needs a real vp.setPartPickMode -- same
    // shape as UI-60's committed precedent (NewOperationModalSourcePartPick
    // .ui60.test.tsx), so the recipe stubs window.__cncViewport.
    const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
    seedSetupWithLoops()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setPartPickMode: (_cb: unknown, _allowed: readonly string[] = []) => {},
      setSelectedPart: () => {},
    }
    try {
      render(<NewOperationModal />)
      act(() => { useCamStore.getState().openModal('new-operation') })
      fireEvent.click(screen.getByText('Geometry'))
      const btn = document.querySelector('[data-testid="op-pick-source-part"]')
      expect(btn, 'the op-pick-source-part button -- recipe stale').not.toBeNull()
      fireEvent.click(btn as Element)
      const { floatingKeys } = censusMustBeClosed('new-operation:source-part-pick-banner')
      expect(floatingKeys).toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner')
    } finally {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    }
  })

  it('banner #1: "Pick from viewport" on a 2D-loop op', async () => {
    await openNewOperation()
    // The loop panel only renders once a geometry is selected on the Geometry
    // tab -- driven exactly as the committed precedent does it
    // (NewOperationModalLoops.smoke.test.tsx:74-78).
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: CENSUS_GEO_ID } })
    // NOT document.querySelector('.op-pick-btn') alone: the new source-part-pick
    // button (data-testid="op-pick-source-part", startSourcePartPicking) shares
    // this class and now renders FIRST in this same tab -- selecting by class
    // alone would silently pick the WRONG banner's opener. Selected by its own
    // text instead, which is also this test's own name.
    const btn = Array.from(document.querySelectorAll('.op-pick-btn'))
      .find((b) => (b.textContent ?? '').trim().startsWith('Pick from viewport'))
    expect(btn, 'the .op-pick-btn "Pick from viewport" (NewOperationModalBody.tsx, startLoopPicking) -- recipe stale').not.toBeUndefined()
    fireEvent.click(btn as Element)
    const { floatingKeys } = censusMustBeClosed('new-operation:loop-pick-banner')
    // #2, not the bare key: the op-source-part-pick-banner (isPickingSourcePart,
    // NewOperationModalBody.tsx:1788) is now the FIRST loop-pick-banner
    // authoring site in source order, so this (isPickingLoops, :1806) is the
    // SECOND.
    expect(floatingKeys).toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner#2')
    // The banner is an early return -- the backdrop is gone, not
    // covered. Same construction as SetupModal's vertex-pick banner.
    expect(floatingKeys).not.toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.modal-backdrop')
  })

  it('banner #2: the B-REP face pick -- a SECOND site of the same class, told apart by its JSX site', async () => {
    // Same class, same owner, same tag as banner #1, at a different site
    // (NewOperationModalBody.tsx:1822 vs :1806). This pair is why the runtime key
    // carries the site: under A3's bare owner+tag+classList scheme they
    // collapse onto one key, and "fixing one" would silently mark the other
    // clean.
    const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
    seedSetupWithBrep()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: CENSUS_GEO_ID } })
    const pickFace = screen.getByTestId('brep-pick-face')
    fireEvent.click(pickFace)
    const { floatingKeys } = censusMustBeClosed('new-operation:brep-face-pick-banner')
    // #3: the THIRD loop-pick-banner authoring site in source order (after the
    // source-part banner and the loop-pick banner above).
    expect(floatingKeys).toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner#3')
    expect(floatingKeys).not.toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner#2')
  })

  it('banner #3: the per-hole review banner on a drill op with detected holes', async () => {
    await openNewOperation()
    // The op type is picked by clicking its CARD, the way a user does -- there
    // is no select to change (NewOperationModalBody.tsx:1958-2044).
    const drillCard = Array.from(document.querySelectorAll('.op-type-card'))
      .find((c) => c.querySelector('.op-type-name')?.textContent === 'Drill')
    expect(drillCard, 'the Drill op-type card -- recipe stale').not.toBeUndefined()
    fireEvent.click(drillCard as Element)
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: CENSUS_GEO_ID } })
    // drillHoleRows is derived from the geometry's closed loops once the op type
    // is drill (NewOperationModalBody.tsx:467) -- the seeded loops ARE the hole
    // set. The per-hole table that carries the review link is on the PASSES tab
    // (:2750), not the Geometry tab the selection was made on.
    fireEvent.click(screen.getByText('Passes'))
    const reviewBtn = document.querySelector('[data-testid="drill-perhole-review-link"]')
    expect(reviewBtn, 'the per-hole review link (NewOperationModalBody.tsx:3564) is banner #3\'s only opener -- recipe stale').not.toBeNull()
    fireEvent.click(reviewBtn as Element)
    const { floatingKeys } = censusMustBeClosed('new-operation:perhole-review-banner')
    expect(floatingKeys).toContain('components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner.op-perhole-review-banner')
  })
})

describe('WO UI-70-R3 / 2h. recipe: the CAM panels\' TreeContextMenu (the OTHER TreeContextMenu)', () => {
  beforeEach(resetStore)

  it('renders both its scrim and its menu from pure props', async () => {
    // Note the file qualifier in these keys: there are TWO components named
    // TreeContextMenu in this tree (this one and the workbench's, covered in
    // 2d). That collision is why the runtime key carries the owner's FILE.
    const { TreeContextMenu } = await import('../../components/panels/TreeContextMenu')
    render(
      <TreeContextMenu
        at={{ x: 10, y: 10 }}
        target={{ kind: 'setup', setupId: CENSUS_SETUP_ID }}
        onAction={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('panels:tree-context-menu')
    expect(floatingKeys).toContain('components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-overlay')
    expect(floatingKeys).toContain('components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-menu')
  })
})

describe('WO UI-70-R3 / 2i. recipe: the sketch overlays', () => {
  // A2 names no 'sketch-session' exemption mechanism, so every one of these
  // must be OBSERVED. They mount directly through the port -- which is a
  // DESIGNED TEST SEAM, not a mock: createCamOverlaysPort's getSurface
  // parameter exists precisely so a test can supply its own projection
  // (camOverlaysPort.ts). The components themselves are all real.
  const fakeSurface = {
    worldToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
    getLastSketchCursor: () => ({ x: 40, y: -30 }),
  }

  let port: ReturnType<typeof createCamOverlaysPort>

  beforeEach(() => {
    resetStore()
    port = createCamOverlaysPort(() => fakeSurface as unknown as SketcherOverlaySurface)
    sketcherToolStore.__reset()
  })

  /** Sketch mode + a live sketch. ORDERING TRAP (SketchDimensionOverlay.smoke
   *  .test.tsx:74-76): setViewerMode('sketch') switches the document and a
   *  document switch RESETS the armed tool, so the tool store is always seeded
   *  AFTER the mode switch, never before. */
  function enterSketch(entities: unknown[] = [], dimensions: unknown[] = []): void {
    act(() => {
      useCamStore.setState({
        activeSketch: {
          id: 's1', layerId: 'L1', entities, constraints: [], dimensions,
          solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
        sketchSelectedIds: [], sketchDimEditor: null,
      } as never)
      useCamStore.getState().setDisplayUnits('mm')
      useCamStore.getState().setViewerMode('sketch')
    })
  }

  const pa = { id: 'pa', kind: 'point', construction: false, at: { x: 0, y: 0 } }
  const pb = { id: 'pb', kind: 'point', construction: false, at: { x: 25, y: 0 } }
  const dimD1 = {
    id: 'd1', kind: 'distance', driving: true, value: 25,
    a: { entityId: 'pa', site: 'self' }, b: { entityId: 'pb', site: 'self' },
    labelAnchor: { x: 12.5, y: 5 },
  }

  it('SketchDimensionOverlay: the layer, a dim label, the dim editor, and the preview HINT (one mount, four sites)', async () => {
    const { SketchDimensionOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchDimensionOverlay')
    enterSketch([pa, pb], [dimD1])
    act(() => {
      useCamStore.setState({ sketchDimEditor: { dimId: 'd1', isNew: false } } as never)
      // A single-point operand set makes planDimension refuse, which is what
      // puts the preview in its HINT variant (mode/tab-hint suppressed).
      sketcherToolStore.setState({ tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ['pa'] } } as never)
    })
    render(<SketchDimensionOverlay port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:dimension-overlay')
    const K = 'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > '
    expect(floatingKeys).toContain(`${K}div.sketch-dim-layer`)
    expect(floatingKeys).toContain(`${K}div`)
    expect(floatingKeys).toContain(`${K}div.sketch-dim-editor`)
    expect(floatingKeys).toContain(`${K}div.sketch-dim-label.sketch-dim-preview.sketch-dim-preview-hint`)
  })

  it('SketchLiveDimsOverlay: the live-dim layer and its labels (a rect chain -- the tool is not read)', async () => {
    const { SketchLiveDimsOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchLiveDimsOverlay')
    enterSketch()
    act(() => {
      sketcherToolStore.setState({
        tool: 'rect-corner',
        chain: { kind: 'rect', mode: 'corner', anchor: { x: 0, y: 0 }, rotated: false },
      } as never)
    })
    render(<SketchLiveDimsOverlay port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:live-dims')
    const K = 'lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx:SketchLiveDimsOverlay > '
    expect(floatingKeys).toContain(`${K}div.sketch-dim-layer.sketch-live-dim-layer`)
    expect(floatingKeys).toContain(`${K}div.sketch-dim-label.sketch-live-dim`)
  })

  it('SketchDrawValueInput: the staged-size entry (fillet armed)', async () => {
    const { SketchDrawValueInput } = await import('../../lib/sketch/sketcher/overlays/SketchDrawValueInput')
    act(() => { useCamStore.getState().startNewSketch() })
    act(() => { sketcherToolStore.setState({ tool: 'fillet', chain: null, filletRadius: 2 } as never) })
    render(<SketchDrawValueInput port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:draw-value-input')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx:SketchDrawValueInput > div.sketch-dim-editor.sketch-draw-value')
  })

  it('SketchTextInput: the text editor, opened through the REAL beginSketchTextEdit action', async () => {
    const { SketchTextInput } = await import('../../lib/sketch/sketcher/overlays/SketchTextInput')
    enterSketch([{ id: 'tx', kind: 'text', construction: false, at: { x: 5, y: 8 }, text: 'HI', height: 6, rotation: 0, fontStyle: 'single-line' }])
    act(() => { useCamStore.getState().beginSketchTextEdit('tx') })
    render(<SketchTextInput port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:text-input')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchTextInput.tsx:SketchTextInput > div.sketch-text-editor')
  })

  it('SketchTextAnchorPill: on-path text, selected (free text renders nothing -- the pill needs a pathId)', async () => {
    const { SketchTextAnchorPill } = await import('../../lib/sketch/sketcher/overlays/SketchTextAnchorPill')
    enterSketch([
      { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
      { id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'HI', height: 6, rotation: 0, fontStyle: 'single-line', pathId: 'ln', pathOffsetMm: 0, pathFlip: false, pathAlign: 'center' },
    ])
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    render(<SketchTextAnchorPill port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:text-anchor-pill')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchTextAnchorPill.tsx:SketchTextAnchorPill > div.sketch-dim-editor.sketch-text-anchor-pill')
  })

  it('SketchPromptBar, ARMED: the tool chip and step counter', async () => {
    // The two prompt-bar surfaces are MUTUALLY EXCLUSIVE (an if/return at
    // SketchPromptBar.tsx:75), so they are two mounts. What separates them is
    // exactly one thing: promptBarModel is 'idle' iff the armed tool is
    // 'select'. Chain, selection and document are irrelevant.
    const { SketchPromptBar } = await import('../../lib/sketch/sketcher/overlays/SketchPromptBar')
    enterSketch()
    act(() => { sketcherToolStore.setState({ tool: 'line', chain: { kind: 'line', prev: { x: 0, y: 0 } } } as never) })
    render(<SketchPromptBar port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:prompt-bar-armed')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar > div.sketch-prompt-bar')
    expect(floatingKeys).not.toContain('lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar > div.sketch-prompt-bar.sketch-prompt-bar-idle')
  })

  it('SketchPromptBar, IDLE: the select-a-tool hint (the ONLY difference is tool === select)', async () => {
    const { SketchPromptBar } = await import('../../lib/sketch/sketcher/overlays/SketchPromptBar')
    enterSketch()
    act(() => { sketcherToolStore.__reset() })
    render(<SketchPromptBar port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:prompt-bar-idle')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar > div.sketch-prompt-bar.sketch-prompt-bar-idle')
  })

  it('SketchConfirmOverlay: the panel AND its input (one state -- no reachable model has zero fields)', async () => {
    const { SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay')
    enterSketch()
    act(() => {
      sketcherToolStore.setState({
        tool: 'pattern-linear',
        chain: { kind: 'linpat', ids: ['e1'], vector: { x: 10, y: 0 } },
        linearPatternCount: 3,
      } as never)
    })
    render(<SketchConfirmOverlay port={port} />)
    const { floatingKeys } = censusMustBeClosed('sketch:confirm-overlay')
    expect(floatingKeys).toContain('lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > div.sketch-confirm-overlay')
    // The input is EXPECTED_IN_FLOW: the static tier only has it in the domain
    // because its className is a prop it could not resolve. The mount answers
    // that guess -- it is an ordinary in-flow control inside the floating panel.
    expect(document.querySelector('.sketch-confirm-overlay input'), 'the confirm overlay must render its field, or the EXPECTED_IN_FLOW claim about it is unproven').not.toBeNull()
  })

  it('SketchConfirmOverlay: WO-1570 chamfer mode buttons AND the Swap control (mode !== equal)', async () => {
    // Same authoring-site key as the mode buttons (see overlayDispositions.ts,
    // "button.sketch-prompt-btn") -- confirmOverlayModel always emits
    // modeOptions for a chamfer chain, and swapAvailable once mode !== 'equal'
    // (confirmOverlay.ts:162-167), so a two-distance corner renders BOTH new
    // sites in one mount.
    const { SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay')
    enterSketch()
    act(() => {
      sketcherToolStore.setState({
        tool: 'chamfer',
        chain: {
          kind: 'chamfer',
          corners: [{
            aId: 'e1', bId: 'e2',
            hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 0 }, at: { x: 0, y: 0 },
            mode: 'two-distance',
          }],
          pendingLineId: null,
          pendingClick: null,
        },
      } as never)
    })
    render(<SketchConfirmOverlay port={port} />)
    censusMustBeClosed('sketch:confirm-overlay-chamfer-mode')
    // The mode buttons/Swap are EXPECTED_IN_FLOW (ordinary in-flow controls
    // inside the already-floating .sketch-confirm-overlay panel, same
    // treatment as this overlay's own input) -- not in floatingKeys
    // themselves. 3 mode buttons + the Swap control, all real DOM nodes --
    // not a written opinion about an element nobody looked at.
    expect(document.querySelectorAll('.sketch-confirm-chamfer-modes button.sketch-prompt-btn').length, 'the mode buttons and Swap control must actually be in the DOM').toBe(4)
  })

  it('SketchContextMenu: the scrim and the menu (no gating at all -- both always render)', async () => {
    const { SketchContextMenu } = await import('../../lib/sketch/sketcher/overlays/SketchContextMenu')
    enterSketch()
    render(<SketchContextMenu port={port} at={{ x: 10, y: 20 }} onClose={() => {}} />)
    const { floatingKeys } = censusMustBeClosed('sketch:context-menu')
    const K = 'lib/sketch/sketcher/overlays/SketchContextMenu.tsx:SketchContextMenu > '
    expect(floatingKeys).toContain(`${K}div.sketch-context-overlay`)
    expect(floatingKeys).toContain(`${K}div.sketch-context-menu`)
  })
})

describe('WO UI-70 (drift catch-up): the SECOND sanctioned context-menu model, at two more sites', () => {
  beforeEach(resetStore)

  it('ViewportContextMenu: the scrim and the menu, mounted directly (pure props, like TreeContextMenu in 2h)', async () => {
    const { ViewportContextMenu } = await import('../../components/viewport/ViewportContextMenu')
    render(
      <ViewportContextMenu
        at={{ x: 10, y: 20 }}
        target={{ kind: 'part', id: 'part-1', label: 'Census Part' }}
        visibility={{ stock: true, workpiece: true, toolpath: true, grid: true }}
        onAction={() => {}}
        onClose={() => {}}
      />,
    )
    const { floatingKeys } = censusMustBeClosed('viewport:context-menu')
    const K = 'components/viewport/ViewportContextMenu.tsx:ViewportContextMenu > '
    expect(floatingKeys).toContain(`${K}div.sketch-context-overlay`)
    expect(floatingKeys).toContain(`${K}div.sketch-context-menu`)
  })

  it('PostGcodeContextMenu: right-click on the g-code preview inside PostProcessModal', async () => {
    // TWO gates stand between openModal and the preview pane rendering at all:
    // (1) the "no setups at all" empty-state guard (PostProcessModal.tsx:704)
    // hides the whole post-grid, including PreviewPane, if project.setups is
    // empty; (2) openContextMenu itself (:1595, `if (!hasGcode && !showRecompute)
    // return`) is a no-op without real g-code or a recompute-needed diagnostic.
    // Same seed shape as the GcodeFlyout recipe above (CAM-15 stampGenerationCurrent).
    const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
    act(() => {
      const s = useCamStore.getState()
      s.addTool({
        id: 'ctxmenu-tool', name: 'Census Tool', type: 'flat_end_mill', diameter: 6,
        shankDiameter: 6, overallLength: 50, fluteLength: 18, shoulderLength: 0,
        numberOfFlutes: 2, cornerRadius: 0, angleFromAxisDeg: 59,
        material: 'carbide', coating: 'none', toolNumber: 113, notes: '',
        libraryId: s.toolLibraries[0]?.id ?? 'lib-default',
        feedsAndSpeeds: {
          default: { rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5, stepover: 3, coolant: 'none' },
        },
      } as never)
    })
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown>; toolLibrary: Tool[] }
      // Read the tool BACK from the live store (see the GcodeFlyout recipe's
      // note above -- the fingerprint must hash the SAME tool object
      // PostProcessModal actually passes to postProject).
      const liveTool = s.toolLibrary.find((t) => t.id === 'ctxmenu-tool')!
      const operation = {
        id: 'ctxmenu-op', name: 'Census Contour', type: 'contour_2d', toolId: 'ctxmenu-tool',
        enabled: true, status: 'ready', geometrySelections: [],
        heights: {
          clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
          topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
        },
        passes: {}, linking: {}, params: {},
        toolpathMoves: [
          { type: 'rapid', x: 0, y: 0, z: 10 },
          { type: 'feed', x: 10, y: 0, z: 0, feed: 1000 },
        ],
      }
      const setup = { id: CENSUS_SETUP_ID, name: 'Census Setup', wcs: CENSUS_WCS, stock: null, notes: '', operations: [operation] }
      const project = { ...s.project, setups: [setup], activeSetupId: CENSUS_SETUP_ID }
      stampGenerationCurrent(
        { ...project, toolLibrary: s.toolLibrary } as unknown as Project,
        setup as unknown as Setup,
        operation as unknown as Operation,
        liveTool,
      )
      useCamStore.setState({ project } as never)
    })
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })
    const preview = document.querySelector('[data-testid="post-gcode-preview"]')
    expect(preview, 'the post-gcode-preview element -- recipe stale').not.toBeNull()
    fireEvent.contextMenu(preview as Element, { clientX: 50, clientY: 60 })
    const { floatingKeys } = censusMustBeClosed('modal:post-gcode-context-menu')
    const K = 'components/modals/PostProcessModal.tsx:PostGcodeContextMenu > '
    expect(floatingKeys).toContain(`${K}div.sketch-context-overlay`)
    expect(floatingKeys).toContain(`${K}div.sketch-context-menu`)
  })
})

describe('WO UI-70 (drift catch-up): the Hole dialog\'s viewport point-picker', () => {
  beforeEach(resetStore)

  it('HolePointPickerOverlay: the layer host and a candidate marker button (UI-67 precedent)', async () => {
    const { HolePointPickerOverlay } = await import('../../components/model3d/dialogs/HoleDialog')
    render(
      <HolePointPickerOverlay
        candidates={[{ id: 'sketch-a:point-a', label: 'Point A', world: { x: 24, y: 18, z: 10 } }]}
        selectedId=""
        projectToCanvas={(point) => ({ x: point.x, y: point.y })}
        onPick={() => {}}
      />,
    )
    // The candidate button only paints once the requestAnimationFrame loop has
    // resolved projectToCanvas at least once (UI-67's own precedent awaits the
    // same thing) -- census reads the live DOM synchronously, so it must wait
    // for the marker to exist first.
    await waitFor(() => { expect(document.querySelector('[data-testid="hole-point-pick-sketch-a:point-a"]')).not.toBeNull() })
    const { floatingKeys } = censusMustBeClosed('hole-dialog:point-picker')
    const K = 'components/model3d/dialogs/HoleDialog.tsx:HolePointPickerOverlay > '
    expect(floatingKeys).toContain(`${K}div.hole-point-pick-layer`)
    expect(floatingKeys).toContain(`${K}button`)
  })
})

// ---------------------------------------------------------------------------
// 3. COMPLETENESS -- amendment A2, direction two (WO UI-70-R3)
// ---------------------------------------------------------------------------
//
// This is the assertion that makes the recipe list above COMPLETE rather than
// merely long, and it is what the R2 audit failed this WO on:
//
//   "A2's load-bearing COMPLETENESS direction is absent. The test records
//    observedFloating and observedRendered, but never asserts that every
//    disposition is observed by a committed mount recipe or covered by one of
//    A2's named non-jsdom mechanisms. [...] unmounted modal, sketch, pick-banner,
//    imperative, and dev-route entries can remain unverified while the 64-test
//    gate stays green."
//
// The fail-closed direction (sections 1 and 2: an unmapped element fails BY
// NAME) answers "is everything the census SAW adjudicated?". It cannot answer
// "did the census see everything?" -- a recipe list covering three surfaces
// passes it forever, which is precisely how the 64-test gate stayed green over
// ~25 unverified entries. That is this section's job, and it is why the recipes
// above had to be built BEFORE this could be written honestly: a completeness
// gate scoped to whatever happens to be implemented asserts nothing at all
// (WORKER-CHARTER item 1).
//
// It runs LAST, deliberately: it reads the observation maps that every recipe
// above filled in as it ran.

describe('WO UI-70-R3 / 3. COMPLETENESS (amendment A2, direction two)', () => {
  /** The three outcomes that are ANSWERS, and the one that is not. */
  type Outcome =
    | { kind: 'OBSERVED-FLOATING'; recipe: string }
    | { kind: 'OBSERVED-IN-FLOW'; recipe: string }
    | { kind: 'EXEMPT'; mechanism: string }
    | { kind: 'UNVERIFIED'; why: string }

  function outcomeFor(key: string): Outcome {
    const entry = keyMap.byAuthoringKey.get(key)
    if (entry === undefined) return { kind: 'UNVERIFIED', why: 'STALE: no live authoring site carries this key any more' }

    const floating = observedFloating.get(entry.site)
    if (floating !== undefined) return { kind: 'OBSERVED-FLOATING', recipe: floating }

    const exemption = CENSUS_EXEMPTIONS[key]
    if (exemption !== undefined) return { kind: 'EXEMPT', mechanism: exemption.mechanism }

    const rendered = observedRendered.get(entry.site)
    if (key in EXPECTED_IN_FLOW) {
      if (rendered === undefined) {
        return {
          kind: 'UNVERIFIED',
          why: 'claimed in EXPECTED_IN_FLOW, but NO recipe ever rendered it -- an unmounted entry is still "nobody '
            + 'knows", and the claim that it does not float is unproven',
        }
      }
      return { kind: 'OBSERVED-IN-FLOW', recipe: rendered }
    }
    return {
      kind: 'UNVERIFIED',
      why: rendered === undefined
        ? 'NO committed mount recipe ever rendered this entry -- nobody has looked at this surface in a live DOM'
        : `rendered by recipe [${rendered}] but never seen FLOATING, and it is not named in EXPECTED_IN_FLOW -- `
          + 'either the disposition is stale or the state that floats it is unreached',
    }
  }

  const ALL_DISPOSITIONED = [...Object.keys(SURFACE_DISPOSITIONS), ...Object.keys(OUT_OF_VIEWPORT_DISPOSITIONS)]

  it('EVERY disposition entry is observed in a committed recipe or carries a named A2 exemption', () => {
    const unverified = ALL_DISPOSITIONED
      .map((key) => ({ key, outcome: outcomeFor(key) }))
      .filter((r) => r.outcome.kind === 'UNVERIFIED')
      .map((r) => `${r.key}\n      ${(r.outcome as { why: string }).why}`)
    expect(
      unverified,
      'UNVERIFIED DISPOSITION ENTR(IES). Each is a surface this census claims to have adjudicated but never actually '
      + 'looked at in a live DOM. A disposition no mount ever reached is a WRITTEN OPINION, not evidence -- and the '
      + 'fail-closed direction cannot catch it, because an element that never renders is never enumerated '
      + `(amendment A2, direction two). ${ALL_DISPOSITIONED.length - unverified.length}/${ALL_DISPOSITIONED.length} `
      + 'entries are answered for; these are not:\n'
      + unverified.map((u) => `  ${u}`).join('\n'),
    ).toEqual([])
  })

  it('every exemption is EARNED: an exempt entry a recipe can reach is stale and fails', () => {
    // The direction that stops the exemption list from decaying into a to-do
    // list. "An exemption entry that becomes mountable must fail the census
    // until dispositioned" (WO UI-70-R3, required shape item 2). An exemption
    // CLAIMS that jsdom cannot host the surface; if a recipe hosts it, the claim
    // is simply false, and the surface must be adjudicated like every other.
    const stale = Object.keys(CENSUS_EXEMPTIONS).filter((key) => {
      const entry = keyMap.byAuthoringKey.get(key)
      if (entry === undefined) return false
      return observedFloating.has(entry.site) || observedRendered.has(entry.site)
    })
    expect(
      stale,
      'STALE EXEMPTION(S): these entries claim no jsdom mount can host them, but a recipe above rendered them:\n'
      + stale.join('\n'),
    ).toEqual([])
  })

  it('every exemption names one of A2\'s four mechanisms, and none is invented', () => {
    const allowed = ['IMPERATIVE-CNCVIEWPORT', 'VIEWCUBE', 'IMPERATIVE-CLASSLIST', 'DEV-ROUTE']
    const bad = Object.entries(CENSUS_EXEMPTIONS)
      .filter(([, e]) => !allowed.includes(e.mechanism))
      .map(([k, e]) => `${k} -> ${e.mechanism}`)
    expect(bad, `exemption(s) claiming a mechanism A2 does not name: ${bad.join(' | ')}`).toEqual([])

    // An exemption for a key nobody dispositions is noise that could hide a
    // typo'd real key behind a green run.
    const orphan = Object.keys(CENSUS_EXEMPTIONS)
      .filter((k) => !(k in SURFACE_DISPOSITIONS) && !(k in OUT_OF_VIEWPORT_DISPOSITIONS))
    expect(orphan, `exemption(s) for un-dispositioned key(s): ${orphan.join(' | ')}`).toEqual([])

    // A2 offers ViewCube "renderer-stub mount OR browser harness". This WO took
    // the mount, so ViewCube claims NO exemption -- asserted rather than left as
    // a claim in a comment, because exempting it would have dropped two real
    // surfaces out of the verdict-bearing census.
    expect(
      Object.values(CENSUS_EXEMPTIONS).some((e) => e.mechanism === 'VIEWCUBE'),
      'ViewCube must be OBSERVED via the renderer-stub mount, not exempted',
    ).toBe(false)
    const viewCubeSite = keyMap.byAuthoringKey.get('components/viewport/ViewCube.tsx:ViewCube > div.view-cube-wrap')?.site
    expect(observedFloating.has(viewCubeSite ?? ''), 'ViewCube is claimed OBSERVED -- so it must be').toBe(true)
  })

  it('EXPECTED_IN_FLOW is not an escape hatch: its entries were mounted and provably did NOT float', () => {
    // The claim these entries make is "the static tier guessed, the mount
    // answered". Both halves are asserted: the entry must have RENDERED (an
    // unmounted one is still "nobody knows", and fails above), and it must never
    // have FLOATED in any recipe -- if it ever floats, this table is lying and
    // the entry is a real surface nobody adjudicated.
    const lying = Object.keys(EXPECTED_IN_FLOW).filter((key) => {
      const entry = keyMap.byAuthoringKey.get(key)
      return entry !== undefined && observedFloating.has(entry.site)
    })
    expect(
      lying,
      'EXPECTED_IN_FLOW claims these entries do not float, but the census SAW them floating:\n' + lying.join('\n'),
    ).toEqual([])

    const orphan = Object.keys(EXPECTED_IN_FLOW).filter((k) => !(k in SURFACE_DISPOSITIONS))
    expect(orphan, `EXPECTED_IN_FLOW entr(ies) for un-dispositioned key(s): ${orphan.join(' | ')}`).toEqual([])
  })
})
