// WO UI-70-R2 -- the RUNTIME KEY SCHEME and the committed authoring->runtime
// mapping (preflight amendment A3, verbatim):
//
//   "Name the runtime identity scheme explicitly: live-DOM census keys are
//    derived from the React fiber owner component name + element tag +
//    classList, and the WO commits the mapping from the 74 authoring-site keys
//    ('file:Component > tag.class') to runtime keys. A lossy or invented
//    mapping that lets two disposition entries collapse into one runtime key
//    fails the census."
//
// ---------------------------------------------------------------------------
// WHY OWNER+TAG+CLASSLIST, ALONE, IS LOSSY -- and what fixes it
// ---------------------------------------------------------------------------
// The amendment's scheme collapses on this tree, and not hypothetically:
//
//   ViewportOverlay authors `div.viewport-mode-banner` at TWO sites (the
//   lay-on-face banner and the project-plane banner). Same owner. Same tag.
//   Same classList. The static census already had to key them
//   `...viewport-mode-banner` and `...viewport-mode-banner#2` for this exact
//   reason -- and it matters, because "fixing one does not fix the other".
//
// Eleven of the 74 carry such an ordinal. Under a bare owner+tag+classList key
// they would collapse in pairs -- which is the failure A3 names. The static
// authoring key already restores 1:1 with a stable `#n` suffix, qualified by the
// owner's file (two components in this tree are both named `TreeContextMenu`).
// React's file:line:column remains the live-DOM JOIN used inside one run, but it
// is deliberately not part of the committed identity: inserting an unrelated
// line above a JSX site must not change the census artifact.
//
// ---------------------------------------------------------------------------
// WHY THE MAPPING IS DERIVED AND NOT HAND-WRITTEN
// ---------------------------------------------------------------------------
// A3 forbids an INVENTED mapping. A hand-typed table would be exactly that, so
// the mapping is DERIVED from the static walk, which reports the stable
// (file, component, tag, classes, ordinal) identity for every authoring site it
// finds. The line and column are retained only for the runtime join and failure
// diagnostics. The stable mapping is published to
// src/tests/evidence/UI-70/OVERLAY-RUNTIME-KEYS.md with a gate that the artifact
// matches the derivation.
//
// This does NOT hand the verdict back to the static tier. The static walk is
// used here for NAMING ONLY -- it says what a site is CALLED, never what is in
// the domain. Membership is decided by the live DOM's own computed positioning
// and nothing else. The direction of failure is what proves this is safe: if
// the static walk is blind to a surface (its styled-wrapper hole is the R1
// audit's BLOCKER), the runtime census still SEES the element, finds no name
// for it, and fails BY NAME as unmapped. A naming blind spot is a RED, never a
// silent pass. That is the property the two previous rounds did not have.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { positionedClasses, walkRenderTree, type Surface } from './overlayRenderTree'
import { SURFACE_DISPOSITIONS, OUT_OF_VIEWPORT_DISPOSITIONS, type Disposition } from './overlayDispositions'
import { SRC_ROOT, OUT_OF_FLOW } from './overlayRuntimeCensus'

export interface KeyMapEntry {
  /** The static census's key: `<file>:<Component> > <tag>.<classes>` (+ `#n`). */
  authoringKey: string
  /** Informational `<file>@<line>:<column>` used only to join the current walk
   *  onto the current live DOM. It is not part of the committed identity. */
  site: string
  file: string
  component: string
  tag: string
  /** Every class the authoring site can emit (all branches of a conditional).
   *  The LIVE classList is a subset -- only the branches that took. */
  authoredClasses: string[]
  line: number
  column: number
  /** The runtime key this site is expected to produce, in A3's scheme. */
  runtimeKey: string
  /** True when the STATIC tier's in-viewport model claims this site -- i.e. it
   *  is one of the 74 in SURFACE_DISPOSITIONS. False for the out-of-flow
   *  surfaces only the runtime tier's wider membership rule reaches. */
  inViewport: boolean
}

export interface KeyMap {
  entries: KeyMapEntry[]
  bySite: Map<string, KeyMapEntry>
  byAuthoringKey: Map<string, KeyMapEntry>
}

export function runtimeKeyOf(e: { authoringKey: string }): string {
  return e.authoringKey
}

/** EVERY floating surface the static walk can name, as (site -> authoring key).
 *
 *  Not just the in-viewport 74: the runtime census's membership test is
 *  positioning alone over the whole document (amendment A4), so it renders
 *  out-of-flow elements the static tier's in-viewport MODEL excludes, and each
 *  of those still has to be named and answered for. The walk is run with
 *  `sticky` added to the position values for the same reason -- A4 names it, and
 *  the static default (absolute|fixed) had left four live sticky surfaces
 *  outside the domain with nothing to say so.
 *
 *  Derived on every run; nothing here is typed by hand. */
export function buildKeyMap(): KeyMap {
  const css = readFileSync(path.join(SRC_ROOT, 'styles', 'app.css'), 'utf8')
  const positionValues = [...OUT_OF_FLOW]
  const positioned = positionedClasses(css, positionValues)
  const walk = walkRenderTree({
    srcRoot: SRC_ROOT,
    roots: [{ file: 'App.tsx', name: 'default' }],
    positioned,
    positionValues,
  })
  const domain: Surface[] = walk.surfaces

  const entries = domain.map((s) => ({
    authoringKey: s.key,
    site: `${s.file}@${s.line}:${s.column}`,
    file: s.file,
    component: s.component,
    tag: s.tag,
    authoredClasses: s.classes,
    line: s.line,
    column: s.column,
    runtimeKey: runtimeKeyOf({ authoringKey: s.key }),
    inViewport: s.inViewport,
  }))

  const bySite = new Map<string, KeyMapEntry>()
  const byAuthoringKey = new Map<string, KeyMapEntry>()
  for (const e of entries) {
    bySite.set(e.site, e)
    byAuthoringKey.set(e.authoringKey, e)
  }
  return { entries, bySite, byAuthoringKey }
}

/** WO UI-70-R3 -- the committed A3 artifact, rendered from the derivation.
 *
 *  The R2 audit's MAJOR: "A3's runtime key derivation and injectivity assertion
 *  exist, but its required committed authoring-site-to-runtime-key mapping does
 *  not. The source comment says the mapping is published to
 *  coordination/evidence/UI-70/OVERLAY-RUNTIME-KEYS.md, yet that path is
 *  absent and no artifact-drift assertion exists."
 *
 *  Rendered MECHANICALLY from buildKeyMap() -- never typed by hand, which is the
 *  "invented mapping" A3 forbids -- and gated byte-for-byte by the census. JSX
 *  coordinates are intentionally omitted because they are diagnostic data, not
 *  identity; unrelated line drift therefore does not churn the artifact. */
export function renderKeyMapArtifact(map: KeyMap): string {
  const inViewport = map.entries.filter((e) => e.inViewport)
  const outOfViewport = map.entries.filter((e) => !e.inViewport)

  const section = (title: string, entries: KeyMapEntry[]): string[] => [
    '', `## ${title} (${entries.length})`, '',
    '| stable authoring key | stable runtime key | dispositioned |',
    '| --- | --- | --- |',
    ...[...entries]
      .sort((a, b) => a.authoringKey.localeCompare(b.authoringKey))
      .map((e) => `| \`${e.authoringKey}\` | \`${e.runtimeKey}\` | ${dispositionFor(e.authoringKey) === undefined ? 'NO' : 'yes'} |`),
  ]

  return [
    '# UI-70 -- the authoring-site -> runtime-key mapping (amendment A3)',
    '',
    'GENERATED FILE. Do not edit by hand: it is rendered from `buildKeyMap()` and',
    'the census gates it byte-for-byte, so a hand edit fails the gate rather than',
    'changing anything. Regenerate with:',
    '',
    '```',
    "$env:UI70_WRITE_KEYS='1'; npx vitest run src/tests/ui/overlayRuntimeCensus.test.tsx; Remove-Item Env:UI70_WRITE_KEYS",
    '```',
    '',
    'WHAT THIS IS. A3 requires the WO to commit the mapping from authoring-site',
    'keys (`file:Component > tag.class`) to the runtime keys the live-DOM census',
    'resolves elements to, so that "the mapping is 1:1" is a checkable claim',
    'rather than an assertion about code nobody can see. Every row is derived: the',
    'authoring key comes from the static walk, and the runtime key from',
    "the same `runtimeKeyOf()` the census's own resolution uses.",
    '',
    'WHY THE RUNTIME KEY CARRIES A STABLE `#n` WHEN NEEDED. A3 specifies owner',
    '+ tag + classList. That scheme is LOSSY on this tree -- ViewportOverlay authors',
    '`div.viewport-mode-banner` at two sites with identical owner, tag and class,',
    'and they would collapse onto one key, which A3 says must fail the census. The',
    'stable authoring ordinal is what keeps the mapping injective; the census',
    'asserts both that the bare scheme collapses here and that the qualified one',
    'does not. Source coordinates remain runtime diagnostics, never identity.',
    '',
    'A `dispositioned: NO` row is NOT a defect: the runtime domain is positioning',
    'over the whole document (A4), which is strictly wider than the in-viewport 74',
    'the disposition tables cover. Such a site fails the census BY NAME if it ever',
    'renders a floating element -- which is the closed domain working, not leaking.',
    ...section('IN-VIEWPORT surfaces -- the static tier\'s domain, dispositioned per site', inViewport),
    ...section('WHOLE-DOCUMENT surfaces -- reachable only by the runtime tier (A4)', outOfViewport),
    '',
  ].join('\n')
}

/** The disposition for an authoring key, from whichever of the two tables
 *  claims it. Undefined means NOBODY has adjudicated this surface -- which is
 *  the census's failure, not a default. */
export function dispositionFor(authoringKey: string): Disposition | undefined {
  return SURFACE_DISPOSITIONS[authoringKey] ?? OUT_OF_VIEWPORT_DISPOSITIONS[authoringKey]
}
