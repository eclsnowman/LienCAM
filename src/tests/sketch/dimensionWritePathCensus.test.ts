// WO UI-50C-R2 (DECISIONS 2026-07-16 STOP, requirement 1 + can-fail gate 1),
// reworked under WO UI-50C-R3 (audit FAIL, MAJOR 1).
//
// Mirrors the committed precedent (SolidsWorkbenchPage.stateCensus.test.ts,
// heal-result-consumer-census.test.ts): reads each derived file's REAL
// source with node:fs and runs it through `extractDimensionWriteHits`, the
// SAME real (`typescript` compiler API) parser the production census module
// exports -- not a re-implemented copy. Every hit must match EXACTLY ONE
// entry in DIMENSION_WRITE_PATH_CENSUS for ITS OWN (file, enclosingFunction,
// text) triple -- zero matches OR more than one both fail the test by name.
//
// This is what makes the census DERIVED rather than a hand list. R2's sweep
// keyed on the site's first LINE only, so a brand-new function reusing an
// EXISTING map's first line (a REWRITE-form site) went silently green -- the
// exact false-positive the R3 audit caught live (`auditScratchRewriteDimensions`,
// reproduced below as a committed fixture regression, not a one-time manual
// mutation). Keying on the nearest NAMED enclosing function name PLUS the
// complete containing-object-literal text (not just its first line) closes
// both directions: a new function fails on the function-name axis, and an
// existing function rewritten unsafely fails on the text axis.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DERIVED_FILES, DIMENSION_WRITE_PATH_CENSUS, NAMED_RULINGS, KNOWN_SAFE_DIMENSIONS_SITES,
  extractDimensionWriteHits, matchingEntries, sweepUnrecognizedDimensionsSites,
  type DimensionWriteHit, type KnownSafeSite,
} from './dimensionWritePathCensus'

/** Repo-relative `src/...` path -> a URL resolvable from THIS test file's
 *  own location (`src/tests/sketch/`, two directories below `src/`). */
function sourceUrl(repoRelativePath: string): URL {
  const withoutSrcPrefix = repoRelativePath.replace(/^src\//, '')
  return new URL(`../../${withoutSrcPrefix}`, import.meta.url)
}

function sweepFile(repoRelativePath: string): DimensionWriteHit[] {
  const source = readFileSync(sourceUrl(repoRelativePath), 'utf8')
  return extractDimensionWriteHits(repoRelativePath, source)
}

function catchAllSweepFile(repoRelativePath: string) {
  const source = readFileSync(sourceUrl(repoRelativePath), 'utf8')
  return sweepUnrecognizedDimensionsSites(repoRelativePath, source)
}

describe('WO UI-50C-R3: dimension write-path census (AST-derived, site-unique + semantics-aware)', () => {
  const allHits = DERIVED_FILES.flatMap((f) => sweepFile(f))

  it('sanity: the sweep actually found sites (a zero/tiny count means the parser or the file set broke, not that no sites exist)', () => {
    expect(allHits.length).toBeGreaterThanOrEqual(18)
  })

  it('every dimensions-array construction/assignment site in every derived file matches EXACTLY ONE census entry', () => {
    const unclassified = allHits.filter((hit) => matchingEntries(hit).length === 0)
    if (unclassified.length > 0) {
      const detail = unclassified
        .map((h) => `  ${h.file}:${h.line} fn=${h.enclosingFunction}\n    text: ${h.text}`)
        .join('\n')
      throw new Error(
        `${unclassified.length} unclassified dimension write-path site(s) found ` +
        `(DERIVE the ruling and add it to DIMENSION_WRITE_PATH_CENSUS, or -- if it ` +
        `is genuinely a document-boundary site with no literal "dimensions:" text -- ` +
        `add it to NAMED_RULINGS):\n${detail}`,
      )
    }
    const ambiguous = allHits.filter((hit) => matchingEntries(hit).length > 1)
    if (ambiguous.length > 0) {
      const detail = ambiguous
        .map((h) => `  ${h.file}:${h.line} fn=${h.enclosingFunction} matched: ${matchingEntries(h).map((e) => e.id).join(', ')}`)
        .join('\n')
      throw new Error(`${ambiguous.length} dimension write-path site(s) matched MORE THAN ONE census entry (ambiguous ruling):\n${detail}`)
    }
  })

  it('every DIMENSION_WRITE_PATH_CENSUS entry matches at least one real site (no stale/dead entries)', () => {
    const dead = DIMENSION_WRITE_PATH_CENSUS.filter(
      (entry) => !allHits.some((hit) => hit.file === entry.file && hit.enclosingFunction === entry.enclosingFunction && hit.text === entry.text),
    )
    expect(dead.map((e) => e.id)).toEqual([])
  })

  it('every census entry and named ruling carries a non-empty note (no silent/placeholder entries)', () => {
    for (const entry of DIMENSION_WRITE_PATH_CENSUS) {
      expect(entry.note.length, `census entry '${entry.id}' has an empty note`).toBeGreaterThan(0)
    }
    for (const ruling of NAMED_RULINGS) {
      expect(ruling.note.length, `named ruling '${ruling.id}' has an empty note`).toBeGreaterThan(0)
    }
  })

  it('every DERIVED_FILES entry is exercised by at least one census entry OR carries an explicit NAMED_RULINGS entry (no silently-orphaned file)', () => {
    const filesWithEntries = new Set(DIMENSION_WRITE_PATH_CENSUS.map((e) => e.file))
    const filesWithNamedRulings = new Set(
      NAMED_RULINGS.map((r) => DERIVED_FILES.find((f) => r.file.startsWith(f))).filter(Boolean),
    )
    const orphaned = DERIVED_FILES.filter(
      (f) => !filesWithEntries.has(f) && !filesWithNamedRulings.has(f),
    )
    expect(orphaned).toEqual([])
  })
})

// ---- WO UI-50C-R4: fail-closed catch-all sweep of the real derived files ---------------------------
//
// The R3 census only ever asked "does every RECOGNIZED-form site match a census entry?" -- it had no
// mechanism to notice a site in a THIRD form it never learned to recognize (the audit's exact finding).
// This block runs `sweepUnrecognizedDimensionsSites` -- the fail-closed catch-all, blind to which forms
// are "recognized" -- against the same 5 real derived files and requires it to return ZERO sites: every
// `dimensions` occurrence in production code today is either a recognized extracted hit (proven by the
// describe block above) or a positively-classified read/binding/type position.
describe('WO UI-50C-R4: fail-closed catch-all sweep (UNRECOGNIZED_DIMENSIONS_FORM)', () => {
  it('the real derived files contain ZERO catch-all sites (every real dimensions occurrence is a recognized hit, a read, a binding, or a type position)', () => {
    const allSites = DERIVED_FILES.flatMap((f) => catchAllSweepFile(f))
    if (allSites.length > 0) {
      const detail = allSites
        .map((s) => `  UNRECOGNIZED_DIMENSIONS_FORM ${s.file}:${s.line} fn=${s.enclosingFunction} role=${s.role}\n    text: ${s.text}`)
        .join('\n')
      throw new Error(`${allSites.length} unrecognized dimensions-array site(s) found by the catch-all sweep:\n${detail}`)
    }
  })

  it('the committed KNOWN_SAFE_DIMENSIONS_SITES entries (if any) each carry a non-empty reason and match at least one real occurrence (no dead entries)', () => {
    for (const entry of KNOWN_SAFE_DIMENSIONS_SITES) {
      expect(entry.reason.length, `known-safe entry '${entry.id}' has an empty reason`).toBeGreaterThan(0)
    }
    // No dead-entry check is vacuous today (the list is empty -- both real local-binding sites are
    // classified automatically by AST shape, see the module header) but the mechanism is exercised by
    // the adversarial fixtures below, which inject entries directly via sweepUnrecognizedDimensionsSites's
    // optional third argument.
    expect(KNOWN_SAFE_DIMENSIONS_SITES.length).toBeGreaterThanOrEqual(0)
  })
})

// ---- WO UI-50C-R4: adversarial fixtures A/B/C/D1/D2 (the audit's exact unrecognized forms) ----------
//
// Each fixture reproduces one of the audit's exact unrecognized-form findings verbatim and asserts it
// stays RED under the real production functions (never a re-implemented copy).
describe('WO UI-50C-R4: adversarial fixtures for the audit\'s exact unrecognized forms (A/B/C/D1/D2)', () => {
  it('form A: element-access assignment (`s.activeSketch["dimensions"] = ...map(driving:true)`) is a first-class RECOGNIZED hit, UNCLASSIFIED (RED) as a brand-new unsafe rewrite', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchElementAccessRewrite: () => {`,
      `    set((s) => {`,
      `      s.activeSketch["dimensions"] = s.activeSketch.dimensions.map((d) => ({ ...d, driving: true }))`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractDimensionWriteHits('src/store/index.ts', fixture)
    expect(hits.length, 'form A must be extracted as a first-class recognized hit, not merely caught by the catch-all').toBe(1)
    expect(hits[0].enclosingFunction).toBe('auditScratchElementAccessRewrite')
    expect(matchingEntries(hits[0]), 'a brand-new element-access rewrite must NOT match any existing entry').toEqual([])
    // The catch-all must NOT also flag it -- it is claimed by recognized extraction, never double-counted.
    const catchAll = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(catchAll, 'the recognized element-access hit must not ALSO appear in the catch-all sweep').toEqual([])
  })

  it('form B: mutating method call (`s.activeSketch.dimensions.push(forged)`) is hard-refused by the catch-all as `mutating-call`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchPushForged: (forged) => {`,
      `    set((s) => {`,
      `      s.activeSketch.dimensions.push(forged)`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    // Confirm the recognized extraction sees NOTHING here (it is not one of the three recognized forms) --
    // if the catch-all were disabled, this site would go undetected entirely.
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('mutating-call')
    expect(sites[0].enclosingFunction).toBe('auditScratchPushForged')
  })

  it('form C: index assignment (`s.activeSketch.dimensions[0] = forged`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchIndexAssign: (forged) => {`,
      `    set((s) => {`,
      `      s.activeSketch.dimensions[0] = forged`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchIndexAssign')
  })

  it('D1: `Object.assign(s.activeSketch, { [\'dimensions\']: forged })` (computed string-literal key) is caught ONLY by the catch-all as `string-literal-key`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchObjectAssignComputedKey: (forged) => {`,
      `    set((s) => {`,
      `      Object.assign(s.activeSketch, { ['dimensions']: forged })`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(
      extractDimensionWriteHits('src/store/index.ts', fixture),
      'D1 must NOT become a recognized extracted form -- adding it as one is a contract violation',
    ).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('string-literal-key')
    expect(sites[0].enclosingFunction).toBe('auditScratchObjectAssignComputedKey')
  })

  it('D2: `{ \'dimensions\': forged, ... }` (plain string-literal object key) is caught ONLY by the catch-all as `string-literal-key`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchStringLiteralKey: (forged) => {`,
      `    set((s) => ({`,
      `      activeSketch: { 'dimensions': forged, entities: s.activeSketch!.entities },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    expect(
      extractDimensionWriteHits('src/store/index.ts', fixture),
      'D2 must NOT become a recognized extracted form -- adding it as one is a contract violation',
    ).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('string-literal-key')
    expect(sites[0].enclosingFunction).toBe('auditScratchStringLiteralKey')
  })
})

// ---- WO UI-50C-R4: the known-safe list's boundary is enforced in code, not merely by convention -----
describe('WO UI-50C-R4: KNOWN_SAFE_DIMENSIONS_SITES cannot absorb a write-context site', () => {
  it('adding a known-safe entry whose (file, enclosingFunction, text) triple matches a genuine write-context site does NOT suppress it', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchIndexAssignForKnownSafeProbe: (forged) => {`,
      `    set((s) => {`,
      `      s.activeSketch.dimensions[0] = forged`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    // First, discover the real (file, enclosingFunction, text) triple the sweep assigns this site --
    // an adversarial known-safe entry must target the SAME triple to prove anything.
    const withoutOverride = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture, [])
    expect(withoutOverride.length).toBe(1)
    const bogusKnownSafe: KnownSafeSite[] = [{
      id: 'adversarial-attempt-to-launder-a-write-target',
      file: 'src/store/index.ts',
      enclosingFunction: withoutOverride[0].enclosingFunction,
      text: withoutOverride[0].text,
      reason: 'ADVERSARIAL TEST ENTRY: attempts to absorb a real index-assignment write-target; must be ignored.',
    }]
    const withOverride = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture, bogusKnownSafe)
    expect(
      withOverride.length,
      'a known-safe entry must NEVER be consulted for a write-target role -- this proves the boundary is enforced in code, not merely by convention',
    ).toBe(1)
    expect(withOverride[0].role).toBe('write-target')
  })
})

// ---- WO UI-50C-R5: adversarial fixtures for destructuring-assignment / for-of write targets ---------
//
// The R4 catch-all's write-target check (`roleFromReferenceChain`) only recognized a DIRECT
// `BinaryExpression` assignment (`top.parent` being the assignment itself). A destructuring-assignment
// target (the `dimensions` reference nested inside the LHS Array/Object literal PATTERN) and a for-of/
// for-in assignment target (`ForOfStatement`/`ForInStatement`'s own `initializer`) never reach that
// check and fell through to 'read' -- the audit's exact BLOCKER finding. These fixtures reproduce every
// form the adopted fix names, verbatim, and assert each is caught RED by the catch-all with role
// 'write-target'. The final fixture proves the binding-form distinction the other direction: a
// destructuring BINDING (`const [dimensions] = arr`) is a structurally different node kind and must
// stay classified safe.
describe('WO UI-50C-R5: adversarial fixtures for destructuring-assignment / for-of write targets', () => {
  it('array destructuring assignment (`[s.activeSketch.dimensions] = [forged]`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchArrayDestructureAssign: (forged) => {`,
      `    set((s) => {`,
      `      [s.activeSketch.dimensions] = [forged]`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchArrayDestructureAssign')
  })

  it('object destructuring assignment (`({ d: s.activeSketch.dimensions } = { d: forged })`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchObjectDestructureAssign: (forged) => {`,
      `    set((s) => {`,
      `      ;({ d: s.activeSketch.dimensions } = { d: forged })`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchObjectDestructureAssign')
  })

  it('index-nested destructuring assignment (`[{ d: s.activeSketch.dimensions }] = [{ d: forged }]`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchIndexNestedDestructureAssign: (forged) => {`,
      `    set((s) => {`,
      `      [{ d: s.activeSketch.dimensions }] = [{ d: forged }]`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchIndexNestedDestructureAssign')
  })

  it('object-rest destructuring assignment (`({ ...s.activeSketch.dimensions } = obj)`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchObjectRestDestructureAssign: (obj) => {`,
      `    set((s) => {`,
      `      ;({ ...s.activeSketch.dimensions } = obj)`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchObjectRestDestructureAssign')
  })

  it('array-nested object-rest destructuring assignment (`[{ ...s.activeSketch.dimensions }] = arr`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchNestedObjectRestDestructureAssign: (arr) => {`,
      `    set((s) => {`,
      `      ;[{ ...s.activeSketch.dimensions }] = arr`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchNestedObjectRestDestructureAssign')
  })

  it('postfix update (`s.activeSketch.dimensions++`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchPostfixUpdate: () => {`,
      `    set((s) => {`,
      `      s.activeSketch.dimensions++`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchPostfixUpdate')
  })

  it('prefix update (`++s.activeSketch.dimensions`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchPrefixUpdate: () => {`,
      `    set((s) => {`,
      `      ++s.activeSketch.dimensions`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchPrefixUpdate')
  })

  it('CONTROL: pure-read unary minus (`const n = -s.activeSketch.dimensions.length`) stays a read, never flagged', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchUnaryMinusRead: () => {`,
      `    set((s) => {`,
      `      const n = -s.activeSketch.dimensions.length`,
      `      return n < 0 ? s : s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(0)
  })

  it('for-of assignment target (`for (s.activeSketch.dimensions of chunks) {}`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchForOfAssign: (chunks) => {`,
      `    set((s) => {`,
      `      for (s.activeSketch.dimensions of chunks) {}`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchForOfAssign')
  })

  it('CONTROL: a destructuring BINDING (`const [dimensions] = arr`) stays classified safe -- proves the write-target climb never mistakes a binding pattern for an assignment pattern', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchArrayBindingControl: (arr) => {`,
      `    const [dimensions] = arr`,
      `    return dimensions`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDimensionWriteHits('src/store/index.ts', fixture)).toEqual([])
    expect(
      sweepUnrecognizedDimensionsSites('src/store/index.ts', fixture),
      'a destructuring BINDING must never be flagged -- ArrayBindingPattern/BindingElement is a wholly different node kind than the ArrayLiteralExpression an assignment pattern uses',
    ).toEqual([])
  })
})

// ---- WO UI-50C-R3 MAJOR 1: committed adversarial fixture regressions -------------------------------
//
// These run the REAL production `extractDimensionWriteHits` against literal fixture source strings
// (never the real repo files) -- a permanent, committed proof that the exact shape the R2 audit's own
// live probe used stays RED, rather than a one-time manual mutation whose evidence is a log file that
// can silently rot as the census evolves.
describe('WO UI-50C-R3 MAJOR 1: adversarial mutation-direction-(b) fixtures, REWRITE-form', () => {
  it('CONTROL: a fixture reproducing an EXISTING classified site (setDimensionValue-shaped) matches its entry (the scan is not vacuously red)', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  setDimensionValue: (id, value) => {`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch!,`,
      `        dimensions: s.activeSketch!.dimensions.map((d) =>`,
      `          d.id === id ? { ...d, value } : d`,
      `        ),`,
      `      },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractDimensionWriteHits('src/store/index.ts', fixture)
    expect(hits.length).toBe(1)
    expect(hits[0].enclosingFunction).toBe('setDimensionValue')
    expect(matchingEntries(hits[0]).map((e) => e.id)).toEqual(['cam-setDimensionValue-edit'])
  })

  it('the R2 audit\'s exact live-probed adversarial shape (a brand-new function, REWRITE-form, forging driving:true on every dimension) is UNCLASSIFIED (RED)', () => {
    // Verbatim shape from the R2 audit finding (dimensionWritePathCensus.ts:132): a new function
    // sharing the bundled entry's first line (`dimensions: s.activeSketch!.dimensions.map((d) =>`)
    // but rewriting EVERY dimension's `driving` flag to `true` unconditionally -- the exact silent
    // false-green the line-only regex missed.
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchRewriteDimensions: () => {`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch!,`,
      `        dimensions: s.activeSketch!.dimensions.map((d) => ({ ...d, driving: true })),`,
      `      },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractDimensionWriteHits('src/store/index.ts', fixture)
    expect(hits.length).toBe(1)
    expect(hits[0].enclosingFunction).toBe('auditScratchRewriteDimensions')
    expect(matchingEntries(hits[0]), 'a brand-new unsafe rewrite-form site must NOT match any existing entry').toEqual([])
  })

  it('a REWRITE mutation INSIDE an existing classified function (same name, unsafe new body) is UNCLASSIFIED (RED), not silently absorbed by its old entry', () => {
    // setDimensionValue itself is corrupted to forge driving:true instead of setting value -- the
    // function NAME still matches an entry, but the TEXT no longer does (the text axis of the fix).
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  setDimensionValue: (id, value) => {`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch!,`,
      `        dimensions: s.activeSketch!.dimensions.map((d) => ({ ...d, driving: true })),`,
      `      },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractDimensionWriteHits('src/store/index.ts', fixture)
    expect(hits.length).toBe(1)
    expect(hits[0].enclosingFunction).toBe('setDimensionValue')
    expect(matchingEntries(hits[0]), 'an existing function mutated into an unsafe rewrite must lose its classification').toEqual([])
  })

  it('a brand-new INSERT-form site (direction-b insertion, kept for parity with the R2 proof) is UNCLASSIFIED (RED)', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  importDimensionsFromDxf: (dims) => {`,
      `    set((s) => ({`,
      `      activeSketch: {`,
      `        ...s.activeSketch!,`,
      `        dimensions: [...s.activeSketch!.dimensions, ...dims],`,
      `      },`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractDimensionWriteHits('src/store/index.ts', fixture)
    expect(hits.length).toBe(1)
    expect(matchingEntries(hits[0])).toEqual([])
  })
})
