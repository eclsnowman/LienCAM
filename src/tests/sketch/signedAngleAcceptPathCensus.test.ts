// WO SKC-59-R3 (audit MAJOR): re-cut of the R1 accept-path census.
//
// R1's census (angleDimSignedEdit.skc59.test.ts, since removed from that
// file) hand-anchored on two named function SIGNATURES and a regex over the
// overlay file. It proved those two specific functions still contained a
// specific substring -- it had no mechanism to notice a NEW value-write site,
// and never looked at the raw `setDimensionValue` sink at all.
//
// This file exercises `signedAngleAcceptPathCensus.ts`'s REAL derivation
// (`findValueWriteSites`, the same `typescript` compiler-API parser the
// production module exports -- never a re-implemented copy) against the five
// real derived files and requires every found site to be either SIGNED
// (proven by dataflow, not asserted) or carry a NAMED, human-reviewed
// angle-irrelevant reason, with exactly one disclosed exception
// (`setDimensionValue`'s raw sink) that is itself named, bounded, and
// re-verified every run to have zero production callers.
//
// SKC-59-R4: per DECISIONS.md's two-bounce STOP, this whole file is a
// TRIPWIRE (catches common shapes and naive new sinks in the five derived
// files) -- NOT a soundness proof. The boundary guard
// (reversedAngleValueSignValid + gcsMapping's reverseB throw) owns the
// actual invariant.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractDimensionWriteHits, DERIVED_FILES } from './dimensionWritePathCensus'
import {
  findValueWriteSites, classifyValueWriteSite, NAMED_ANGLE_IRRELEVANT_VALUE_WRITES,
  type ValueWriteSite, type NamedAngleIrrelevantReason,
} from './signedAngleAcceptPathCensus'

function sourceUrl(repoRelativePath: string): URL {
  const withoutSrcPrefix = repoRelativePath.replace(/^src\//, '')
  return new URL(`../../${withoutSrcPrefix}`, import.meta.url)
}

function sitesOf(repoRelativePath: string): ValueWriteSite[] {
  const source = readFileSync(sourceUrl(repoRelativePath), 'utf8')
  return findValueWriteSites(repoRelativePath, source)
}

/** The ONE disclosed, deliberately-unclassified gap: `setDimensionValue`
 *  writes the raw typed magnitude with no sign normalization and no guard
 *  against `dim.kind === 'angle'`. It has no production caller today (proven
 *  below by a repo-wide grep, not merely asserted), so it is not a live
 *  runtime defect -- but it is not "safe by construction" the way every
 *  `NAMED_ANGLE_IRRELEVANT_VALUE_WRITES` entry is, so it is named here
 *  instead of laundered into that list. */
const DISCLOSED_UNSAFE_GAP = {
  file: 'src/store/index.ts',
  enclosingFunction: 'setDimensionValue',
  containerText: '{ ...d, value }',
}

describe('WO SKC-59-R3/R4: signed-angle accept-path census -- TRIPWIRE, not a proof (the boundary guard owns the invariant)', () => {
  const allSites = DERIVED_FILES.flatMap((f) => sitesOf(f))

  it('sanity: the sweep actually found sites (a zero/tiny count means the parser or the function-name domain broke)', () => {
    expect(allSites.length).toBeGreaterThanOrEqual(11)
  })

  it('every derived value-write site is SIGNED, carries a NAMED angle-irrelevant reason, or is the ONE disclosed gap -- never silently UNCLASSIFIED', () => {
    const verdicts = allSites.map((site) => ({ site, verdict: classifyValueWriteSite(site, NAMED_ANGLE_IRRELEVANT_VALUE_WRITES) }))
    const unexplained = verdicts.filter(({ site, verdict }) => {
      if (verdict.classification !== 'UNCLASSIFIED') return false
      const isDisclosedGap =
        site.file === DISCLOSED_UNSAFE_GAP.file &&
        site.enclosingFunction === DISCLOSED_UNSAFE_GAP.enclosingFunction &&
        site.containerText === DISCLOSED_UNSAFE_GAP.containerText
      return !isDisclosedGap
    })
    if (unexplained.length > 0) {
      const detail = unexplained
        .map(({ site }) => `  ${site.file}:${site.line} fn=${site.enclosingFunction}\n    value write: ${site.containerText}`)
        .join('\n')
      throw new Error(
        `${unexplained.length} unclassified signed-angle value-write site(s) found (route the value through ` +
        `signedAngleEditValue, or add a NamedAngleIrrelevantReason entry to signedAngleAcceptPathCensus.ts naming ` +
        `why it is safe, or -- if it is a genuinely new disclosed gap -- extend DISCLOSED_UNSAFE_GAP handling):\n${detail}`,
      )
    }
  })

  it('the ONE disclosed gap (setDimensionValue raw sink) is present, unsigned, and matches EXACTLY the expected shape (no silent drift)', () => {
    const site = allSites.find(
      (s) => s.file === DISCLOSED_UNSAFE_GAP.file && s.enclosingFunction === DISCLOSED_UNSAFE_GAP.enclosingFunction,
    )
    expect(site, 'setDimensionValue must still exist and be swept').toBeDefined()
    expect(site!.containerText).toBe(DISCLOSED_UNSAFE_GAP.containerText)
    expect(site!.routesThroughSignedHelper, 'the gap is that this site is UNSIGNED -- if this ever becomes true, delete the disclosed-gap carve-out').toBe(false)
  })

  it('the disclosed gap has ZERO production callers today (repo-wide grep) -- if this ever fails, the gap is now reachable for an angle dim and MUST be fixed, not re-disclosed', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoSrc = resolve(here, '../..')
    const callers: string[] = []
    ;(function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (full.replace(/\\/g, '/').includes('/tests/')) continue // this census's own files, and other test files
        const text = readFileSync(full, 'utf8')
        // The definition site itself (`setDimensionValue: (id, value) => {`) and its interface
        // declaration (`setDimensionValue: (id: string, value: number) => void`) both live in
        // store/index.ts and are not calls -- exclude by requiring a `.setDimensionValue(` CALL
        // shape (a receiver dot, not a colon-bound definition).
        if (/\.setDimensionValue\(/.test(text)) callers.push(full)
      }
    })(repoSrc)
    expect(callers, `unexpected production caller(s) of setDimensionValue: ${callers.join(', ')}`).toEqual([])
  })

  it('every NAMED_ANGLE_IRRELEVANT_VALUE_WRITES entry matches at least one real site (no stale/dead entries)', () => {
    const dead = NAMED_ANGLE_IRRELEVANT_VALUE_WRITES.filter(
      (entry: NamedAngleIrrelevantReason) => !allSites.some(
        (s) => s.file === entry.file && s.enclosingFunction === entry.enclosingFunction && s.containerText === entry.containerText,
      ),
    )
    expect(dead.map((e) => e.id)).toEqual([])
  })

  it('every NAMED_ANGLE_IRRELEVANT_VALUE_WRITES entry carries a non-empty reason', () => {
    for (const entry of NAMED_ANGLE_IRRELEVANT_VALUE_WRITES) {
      expect(entry.reason.length, `entry '${entry.id}' has an empty reason`).toBeGreaterThan(0)
    }
  })

  it('at least the two known signed sinks (CAM store + workbench port commitDimensionValue) are classified SIGNED', () => {
    const signedFns = allSites
      .filter((s) => classifyValueWriteSite(s, NAMED_ANGLE_IRRELEVANT_VALUE_WRITES).classification === 'signed')
      .map((s) => `${s.file}#${s.enclosingFunction}`)
    expect(signedFns).toContain('src/store/index.ts#commitDimensionValue')
    expect(signedFns).toContain('src/components/model3d/workbench/workbenchOverlaysPort.ts#commitDimensionValue')
  })
})

// ---------------------------------------------------------------------------
// The overlay gap: SketchDimensionOverlay.tsx is NOT one of DERIVED_FILES (it
// holds no `dimensions:` literal -- it delegates). Prove, mechanically, that
// it never writes `dimensions` itself (reusing the sibling census's own
// proven extractor against the overlay's real source) and that it actually
// calls through to the host port at least twice (Enter + blur).
// ---------------------------------------------------------------------------
describe('WO SKC-59-R3/R4 TRIPWIRE: the overlay never bypasses the host port', () => {
  const overlayPath = 'src/lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx'

  it('the overlay constructs/assigns NO `dimensions` array itself (reusing the proven dimensionWritePathCensus extractor)', () => {
    const source = readFileSync(sourceUrl(overlayPath), 'utf8')
    const hits = extractDimensionWriteHits(overlayPath, source)
    expect(hits, 'the overlay must never write `dimensions` directly -- that is the host port\'s job').toEqual([])
  })

  it('the overlay delegates to port.commitDimensionValue at least twice (onKeyDown Enter + onBlur)', () => {
    const source = readFileSync(sourceUrl(overlayPath), 'utf8')
    const commits = source.match(/port\.commitDimensionValue\(/g) ?? []
    expect(commits.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Adversarial fixture proof (WO SKC-59-R3 cure C1's mutation requirement,
// "simulate via the census's own fixture" -- mirrors the sibling census's own
// adversarial-fixture idiom in dimensionWritePathCensus.test.ts): a fake new
// UNSIGNED value-write bolted onto an EXISTING census-named function must be
// found and reported UNCLASSIFIED against the real classification list; the
// same source with the bypass line removed matches cleanly.
// ---------------------------------------------------------------------------
describe('WO SKC-59-R3/R4 TRIPWIRE: adversarial fixture -- a fake bypass accept site goes RED, removing it goes GREEN', () => {
  // A minimal stand-in for store/index.ts that keeps EXACTLY the shape
  // findValueWriteSites needs: a function named 'commitDimensionValue' (a
  // name DIMENSION_WRITE_PATH_CENSUS already binds to this file, so it is in
  // this module's target-function set) containing a fresh, UNSIGNED
  // `value:` write alongside the real signed one.
  function fixture(includeBypass: boolean): string {
    return [
      `export const camStoreCreator = (set, get) => ({`,
      `  commitDimensionValue: (dimId, value) => {`,
      `    const dim = get().activeSketch.dimensions.find((d) => d.id === dimId)`,
      `    const signedValue = signedAngleEditValue(dim, value)`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch,`,
      `        dimensions: s.activeSketch.dimensions.map((d) =>`,
      `          d.id === dimId ? { ...d, value: signedValue } : d`,
      `        ),`,
      `      },`,
      `    }))`,
      includeBypass
        ? [
            `    // AUDIT-SCRATCH bypass: a hypothetical SECOND accept path added later in the`,
            `    // same function, forgetting to sign the value.`,
            `    if (dim.kind === 'auditScratchBypassKind') {`,
            `      set((s) => ({`,
            `        activeSketch: {`,
            `          ...s.activeSketch,`,
            `          dimensions: s.activeSketch.dimensions.map((d) =>`,
            `            d.id === dimId ? { ...d, value: value } : d`,
            `          ),`,
            `        },`,
            `      }))`,
            `    }`,
          ].join('\n')
        : '',
      `  },`,
      `})`,
    ].filter((line) => line !== '').join('\n')
  }

  it('RED: the fixture WITH the bypass reports an UNCLASSIFIED unsigned value-write site', () => {
    const sites = findValueWriteSites('src/store/index.ts', fixture(true))
    const verdicts = sites.map((s) => classifyValueWriteSite(s, NAMED_ANGLE_IRRELEVANT_VALUE_WRITES))
    const unclassified = verdicts.filter((v) => v.classification === 'UNCLASSIFIED')
    expect(unclassified.length, 'the bypass site must be found and reported UNCLASSIFIED').toBe(1)
    expect(unclassified[0].site.containerText).toBe('{ ...d, value: value }')
    expect(unclassified[0].site.routesThroughSignedHelper).toBe(false)
    // The REAL signed site in the same function must still classify correctly alongside the bypass.
    const signed = verdicts.filter((v) => v.classification === 'signed')
    expect(signed.length).toBe(1)
  })

  it('GREEN: the fixture WITHOUT the bypass has zero UNCLASSIFIED sites', () => {
    const sites = findValueWriteSites('src/store/index.ts', fixture(false))
    const verdicts = sites.map((s) => classifyValueWriteSite(s, NAMED_ANGLE_IRRELEVANT_VALUE_WRITES))
    expect(verdicts.filter((v) => v.classification === 'UNCLASSIFIED')).toEqual([])
    expect(verdicts.filter((v) => v.classification === 'signed').length).toBe(1)
  })

  it('a brand-new, differently-named function is invisible to THIS census (by design -- it must first be classified by the sibling dimensionWritePathCensus, whose own exhaustive sweep would flag it before it ever reaches this module\'s target-function set)', () => {
    const fixtureWithNewFunction = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchBrandNewAcceptPath: (dimId, value) => {`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch,`,
      `        dimensions: s.activeSketch.dimensions.map((d) =>`,
      `          d.id === dimId ? { ...d, value: value } : d`,
      `        ),`,
      `      },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    // Proves the boundary this module documents: a function name NOT already in
    // DIMENSION_WRITE_PATH_CENSUS for this file is outside this module's scan entirely.
    expect(findValueWriteSites('src/store/index.ts', fixtureWithNewFunction)).toEqual([])
  })
})
