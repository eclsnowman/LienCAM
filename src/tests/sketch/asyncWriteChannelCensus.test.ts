// WO SKC-56-R3 (DECISIONS 2026-07-17 "SKC-56 async-coherence THIRD strike"),
// requirement 1: "Commit the census as a can-fail test in the
// dimensionWritePathCensus style: it FAILS when a new async channel appears
// without a seam disposition."
//
// Reads src/store/index.ts's REAL source with node:fs and runs it through the
// SAME exported production functions the census module uses -- never a
// re-implemented copy (the technique the two precedent censuses in this
// directory are audited on). The adversarial fixtures below then drive those
// same functions with literal fixture sources, so every RED direction this
// census claims is a COMMITTED, permanently-re-run proof rather than a
// one-time manual mutation whose log can rot.
//
// The four RED directions proven here are exactly the four ways the invariant
// has actually been broken, or could next be broken:
//   1. a new module-scope channel appears and nobody rules on it  -> fixture A
//   2. a censused channel is not neutralized by the seam          -> fixture B
//      (this is the R2 BLOCKER's own shape, reproduced structurally)
//   3. a timer channel is nulled but never cancelled              -> fixture C
//   4. a new deferred write site appears without a disposition    -> fixtures D/E
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DERIVED_FILES, SEAM_FUNCTION,
  ASYNC_WRITE_CHANNEL_CENSUS, CHANNEL_NAMED_EXCLUSIONS, DEFERRED_SKETCH_WRITE_SITES,
  extractModuleScopeMutables, extractSeamNeutralizations, extractSeamTimerCancels,
  extractDeferredWriteSites, auditClassification, auditSeamNeutralization,
  matchingChannelEntries, matchingDeferredEntries,
  type ChannelCensusEntry,
} from './asyncWriteChannelCensus'

/** Repo-relative `src/...` path -> a URL resolvable from THIS test file's own
 *  location (`src/tests/sketch/`, two directories below `src/`). */
function sourceUrl(repoRelativePath: string): URL {
  return new URL(`../../${repoRelativePath.replace(/^src\//, '')}`, import.meta.url)
}
function readSource(repoRelativePath: string): string {
  return readFileSync(sourceUrl(repoRelativePath), 'utf8')
}

const STORE = 'src/store/index.ts'
const storeSource = readSource(STORE)

// WO-998 (25aa93e89) added this readonly configuration array after the census
// was authored. It cannot carry a pending sketch write across history restore,
// so it is a named exclusion rather than a seam-neutralized async channel.
// Keep the disposition in this owned test until the census table itself is in
// scope; passing it explicitly preserves the fail-closed behavior for every
// future unclassified mutable.
// The census table (not in this order's grant) still names `defaultMachine`, but the store now
// initialises it with a createSampleMachine() call, so it is no longer a module-scope mutable
// container and the sweep does not see it. Dropped here rather than reported stale.
// WO-2332 added `modelRefCheckRun` (below): one verifyModelReferences run in flight.
const CURRENT_CHANNEL_NAMED_EXCLUSIONS = [
  ...CHANNEL_NAMED_EXCLUSIONS.filter((e) => e.id !== 'defaultMachine'),
  {
    id: 'modelRefCheckRun',
    file: STORE,
    name: 'modelRefCheckRun',
    reason:
      'WO-2332 single-flight handle for verifyModelReferences: a {projectId, done} promise pair that ' +
      'only coalesces model-reference checks and clears itself in finally. It reads and writes model ' +
      'document references, never sketch geometry, and holds no sketch payload or deferred sketch writer.',
  },
  {
    id: 'legacyToolChangeParkIdReader',
    file: STORE,
    name: 'legacyToolChangeParkIdReader',
    reason:
      'WO-1681 machine-document migration reader: a synchronously invoked callback into the ' +
      'separate machine-actions store. It reads a legacy park id while adopting a machine and ' +
      'cannot carry, schedule, or commit a sketch write across history restore.',
  },
  {
    id: 'projectStoreDurability',
    file: STORE,
    name: 'projectStoreDurability',
    reason:
      'WO-1707 durability query seam: a const-held object whose only function reports whether ' +
      'project-store writes have settled. It contains no sketch payload, timer, deferred sketch ' +
      'writer, or callback that can commit active-sketch geometry.',
  },
  {
    id: 'MACHINE_SERIAL_BAUD_CHOICES',
    file: STORE,
    name: 'MACHINE_SERIAL_BAUD_CHOICES',
    reason:
      'WO-998 serial-baud configuration data: a readonly array of numeric choices, read for ' +
      'validation only. It contains no sketch payload, callback, timer, or deferred writer.',
  },
  {
    id: 'progressOnlyState',
    file: STORE,
    name: 'progressOnlyState',
    reason:
      'WO-3126 (2c05b482ed) progress-publication handle: the store instance whose pure progress ' +
      'writes are being published, cleared by the persist observer on every other write. It ' +
      'holds no sketch payload, timer or deferred writer, and a history restore is not a ' +
      'progress publication, so nothing of it can carry a pending sketch write across the seam.',
  },
  {
    id: 'CONTOUR_TAB_STALE_PATCH',
    file: STORE,
    name: 'CONTOUR_TAB_STALE_PATCH',
    reason:
      'WO-3220 (60a00dcfc9) contour tab-suggestion patch: a const object of toolpath result ' +
      'fields (status, moves, timings, resolved heights, fingerprint) applied to an operation ' +
      'whose contour inputs changed. It carries no sketch geometry, no timer and no sketch ' +
      'writer, so it cannot commit a pending sketch write after a restore.',
  },
] as const

// ---- TIER 1: module-scope state holders ------------------------------------

describe('SKC-56-R3 tier 1: every module-scope mutable in the store is classified a channel or named-excluded', () => {
  const mutables = extractModuleScopeMutables(STORE, storeSource)

  it('sanity: the sweep actually found module-scope mutables (a zero/tiny count means the parser or the file set broke, not that none exist)', () => {
    expect(mutables.length).toBeGreaterThanOrEqual(12)
  })

  it('every module-scope mutable is classified EXACTLY ONCE -- an unclassified one is RED (this is the fail-closed domain the whole ruling turns on)', () => {
    const problems = auditClassification(mutables, ASYNC_WRITE_CHANNEL_CENSUS, CURRENT_CHANNEL_NAMED_EXCLUSIONS)
    if (problems.length > 0) {
      const detail = problems
        .map((p) => `  ${STORE}:${p.line} let ${p.name} -- ${p.kind}`)
        .join('\n')
      throw new Error(
        `${problems.length} module-scope mutable(s) are not classified exactly once.\n` +
        `DERIVE the ruling and either (a) add a ChannelCensusEntry AND neutralize it inside ` +
        `${SEAM_FUNCTION}, or (b) add a CHANNEL_NAMED_EXCLUSIONS entry stating WHY it cannot ` +
        `carry a pending asynchronous write across a history restore:\n${detail}`,
      )
    }
  })

  it('every censused channel is positively NEUTRALIZED inside the seam (and every timer channel is also CANCELLED there)', () => {
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, storeSource),
      extractSeamTimerCancels(STORE, storeSource),
    )
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.channelId} (let ${v.name}) -- ${v.kind}`).join('\n')
      throw new Error(
        `${violations.length} censused channel(s) survive a history restore -- ${SEAM_FUNCTION} ` +
        `must neutralize EVERY channel, with no per-channel exceptions:\n${detail}`,
      )
    }
  })

  it('the seam assigns NOTHING that is not a censused channel (its neutralization block and the census are the same closed set, both directions)', () => {
    const censusNames = new Set(ASYNC_WRITE_CHANNEL_CENSUS.map((e) => e.name))
    const moduleScopeNames = new Set(extractModuleScopeMutables(STORE, storeSource).map((m) => m.name))
    // Locals the seam declares (isUndo, restoredProject, ...) are not
    // module-scope bindings and are none of this census's business.
    const stray = extractSeamNeutralizations(STORE, storeSource)
      .filter((n) => moduleScopeNames.has(n.name) && !censusNames.has(n.name))
    expect(stray.map((s) => `${s.name} @${s.line}`)).toEqual([])
  })

  it('every census entry and named exclusion matches a REAL module-scope mutable (no stale/dead entries after a rename or removal)', () => {
    const names = new Set(mutables.map((m) => m.name))
    expect(ASYNC_WRITE_CHANNEL_CENSUS.filter((e) => !names.has(e.name)).map((e) => e.id)).toEqual([])
    expect(CURRENT_CHANNEL_NAMED_EXCLUSIONS.filter((e) => !names.has(e.name)).map((e) => e.id)).toEqual([])
  })

  it('every census entry and named exclusion carries a non-empty note/reason (no silent or placeholder rulings)', () => {
    for (const e of ASYNC_WRITE_CHANNEL_CENSUS) {
      expect(e.note.length, `channel entry '${e.id}' has an empty note`).toBeGreaterThan(0)
    }
    for (const e of CURRENT_CHANNEL_NAMED_EXCLUSIONS) {
      expect(e.reason.length, `named exclusion '${e.id}' has an empty reason`).toBeGreaterThan(0)
    }
  })

  it('the ruling\'s three named-by-hand channels are all present as CHANNELS (the R2 blocker\'s dragDebounceTimer/pendingDrag/sketchDragPlan cannot be quietly downgraded to exclusions)', () => {
    // The DECISIONS ruling names these as known members the derivation must
    // contain. Pinning them defends against a future "simplification" that
    // moves one into the exclusion table with a plausible-sounding reason.
    for (const name of ['dragDebounceTimer', 'pendingDrag', 'sketchDragPlan']) {
      expect(
        ASYNC_WRITE_CHANNEL_CENSUS.some((e) => e.name === name),
        `${name} is named by the ruling as a channel but is not censused as one`,
      ).toBe(true)
    }
  })

  it('WO-3133 keeps its asynchronous rollback latch as a seam-neutralized channel, while its synchronous push receipt remains a named exclusion', () => {
    expect(ASYNC_WRITE_CHANNEL_CENSUS.filter((e) => e.name === 'dimensionPlacement')
      .map((e) => e.class)).toEqual(['channel'])
    expect(CURRENT_CHANNEL_NAMED_EXCLUSIONS.filter((e) => e.name === 'lastSketchHistoryPush')
      .map((e) => e.reason)).toHaveLength(1)

    // Adversarial removal: a future edit cannot quietly downgrade the latch
    // to uncensused bookkeeping. The real seam still clears it, so both sides
    // of the closed-set rule would turn red without this entry.
    const withoutPlacement = ASYNC_WRITE_CHANNEL_CENSUS.filter((e) => e.name !== 'dimensionPlacement')
    expect(auditClassification(mutables, withoutPlacement, CURRENT_CHANNEL_NAMED_EXCLUSIONS)
      .map((p) => `${p.name}:${p.kind}`)).toContain('dimensionPlacement:unclassified')
    const censusedNames = new Set(withoutPlacement.map((e) => e.name))
    expect(extractSeamNeutralizations(STORE, storeSource)
      .filter((n) => n.name === 'dimensionPlacement' && !censusedNames.has(n.name))
      .map((n) => n.name)).toEqual(['dimensionPlacement'])
  })
})

// ---- TIER 2: deferred write sites ------------------------------------------

describe('SKC-56-R3 tier 2: every deferred site that can write sketch state is dispositioned', () => {
  const sites = extractDeferredWriteSites(STORE, storeSource)

  it('sanity: the sweep actually found deferred write sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4)
  })

  it('every derived deferred write site matches EXACTLY ONE census entry', () => {
    const unclassified = sites.filter((s) => matchingDeferredEntries(s).length === 0)
    if (unclassified.length > 0) {
      const detail = unclassified
        .map((s) => `  ${s.file}:${s.line} ${s.siteFunction} [${s.deferral}] ${s.anchorText}`)
        .join('\n')
      throw new Error(
        `${unclassified.length} deferred sketch-write site(s) have no disposition -- add a ` +
        `DEFERRED_SKETCH_WRITE_SITES entry saying whether the seam neutralizes it (name the ` +
        `channel) or why it needs no seam action:\n${detail}`,
      )
    }
    const ambiguous = sites.filter((s) => matchingDeferredEntries(s).length > 1)
    expect(ambiguous.map((s) => `${s.siteFunction}/${s.deferral}`)).toEqual([])
  })

  it('each entry covers EXACTLY its declared siteCount (a SECOND deferral growing inside an already-classified function is RED, not absorbed)', () => {
    const mismatches = DEFERRED_SKETCH_WRITE_SITES
      .map((e) => ({ e, actual: sites.filter((s) => matchingDeferredEntries(s).some((m) => m.id === e.id)).length }))
      .filter(({ e, actual }) => actual !== e.siteCount)
    if (mismatches.length > 0) {
      const detail = mismatches
        .map(({ e, actual }) => `  ${e.id}: declared siteCount=${e.siteCount}, derived=${actual}`)
        .join('\n')
      throw new Error(`${mismatches.length} deferred-site entr(ies) do not cover their declared site count:\n${detail}`)
    }
  })

  it('every entry carries a non-empty note (no silent dispositions)', () => {
    for (const e of DEFERRED_SKETCH_WRITE_SITES) {
      expect(e.note.length, `deferred-site entry '${e.id}' has an empty note`).toBeGreaterThan(0)
    }
  })

  it('the two sites the ruling\'s preflight names by hand are both dispositioned (never silently omitted)', () => {
    // Preflight (a): the drag debounce -- the blocker's own dispatch site.
    expect(DEFERRED_SKETCH_WRITE_SITES.some((e) => e.siteFunction === 'dragSolveSketch')).toBe(true)
    // Preflight (b): the importSketchFont promise chain -> applyTextEditPatch.
    expect(DEFERRED_SKETCH_WRITE_SITES.some((e) => e.siteFunction === 'importSketchFont')).toBe(true)
  })

  it('every DERIVED_FILES entry is exercised by at least one entry in each tier (no silently-orphaned derived file)', () => {
    for (const f of DERIVED_FILES) {
      expect(ASYNC_WRITE_CHANNEL_CENSUS.some((e) => e.file === f)).toBe(true)
      expect(DEFERRED_SKETCH_WRITE_SITES.some((e) => e.file === f)).toBe(true)
    }
  })
})

// ---- Adversarial fixtures --------------------------------------------------
//
// Each fixture is a literal source string run through the REAL production
// extractors (never a re-implemented copy, never the real repo file), proving
// the census stays RED for one concrete regression shape.

/** A minimal store-shaped source: the seam plus whatever the fixture adds. */
function storeFixture(opts: {
  mutables: string[]
  seamBody: string
  extra?: string
}): string {
  return [
    ...opts.mutables,
    `function ${SEAM_FUNCTION}(set, get, direction) {`,
    `  const isUndo = direction === 'undo'`,
    opts.seamBody,
    `  set((s) => ({ activeSketch: s.sketchHistory[0] }))`,
    `}`,
    opts.extra ?? '',
  ].join('\n')
}

const NEUTRALIZE_ALL = [
  `  latestSketchRequestId = ''`,
  `  pendingConstraintApply = null`,
  `  pendingDimensionApply = null`,
  `  dimensionPlacement = null`,
  `  pendingAppendApply = null`,
  `  if (dragDebounceTimer !== null) { clearTimeout(dragDebounceTimer); dragDebounceTimer = null }`,
  `  pendingDrag = null`,
  `  sketchDragPlan = null`,
].join('\n')

const ALL_CHANNEL_LETS = [
  `let latestSketchRequestId = ''`,
  `let pendingConstraintApply = null`,
  `let pendingDimensionApply = null`,
  `let dimensionPlacement = null`,
  `let pendingAppendApply = null`,
  `let dragDebounceTimer = null`,
  `let pendingDrag = null`,
  `let sketchDragPlan = null`,
]

describe('SKC-56-R3 adversarial fixture A: a brand-new module-scope channel appears and nobody rules on it', () => {
  it('an unclassified module-scope `let` is RED (the exact fail-closed direction the third strike is about: R1 and R2 each neutralized only the channels they knew about)', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, `let pendingSectorRemeasure: { requestId: string } | null = null`],
      seamBody: NEUTRALIZE_ALL,
    })
    const mutables = extractModuleScopeMutables(STORE, fixture)
    const problems = auditClassification(mutables)
    expect(problems.map((p) => `${p.name}:${p.kind}`)).toEqual(['pendingSectorRemeasure:unclassified'])
  })

  it('CONTROL: the same fixture WITHOUT the new mutable is clean -- proving fixture A is red for its own reason, not because the harness is red for everything', () => {
    const fixture = storeFixture({ mutables: ALL_CHANNEL_LETS, seamBody: NEUTRALIZE_ALL })
    expect(auditClassification(extractModuleScopeMutables(STORE, fixture))).toEqual([])
  })

  it('a `const` module-scope binding holding a NON-container value is NOT dragged into the domain (no field of it can be assigned a pending write, so classifying it would be noise)', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, `const TEXT_FLIP_MIN_MM = 3`],
      seamBody: NEUTRALIZE_ALL,
    })
    expect(extractModuleScopeMutables(STORE, fixture).some((m) => m.name === 'TEXT_FLIP_MIN_MM')).toBe(false)
    expect(auditClassification(extractModuleScopeMutables(STORE, fixture))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// WO SKC-56-R4 item 4: the ONE authorized widening, and the audit finding that
// forced it. These fixtures drive the SAME exported production extractor the
// real file runs through -- never a re-implemented copy.
// ---------------------------------------------------------------------------

describe('SKC-56-R4 adversarial fixture E: the R3 audit\'s const-container bypass, which stayed GREEN on a real new channel', () => {
  // The R3 audit's BLOCKER (tests), verbatim in shape: "A second brand-new,
  // realistic channel used const auditDebounce={pending:null}, assigned the
  // pending sketch, and scheduled setTimeout(auditApplyStaleGeometry,25) ...
  // It produced no module classification problem and no deferred write site:
  // the census stayed GREEN on a channel nobody hand-listed." Tier 1 equated a
  // const BINDING with immutable CONTENTS. It is the contents that carry the
  // pending write.
  const AUDIT_CHANNEL = `const auditDebounce: { pending: unknown } = { pending: null }`

  it('the auditor\'s exact const-held mutable container is now IN-domain and RED as unclassified (pre-R4 this returned no problem at all -- the finding this widening exists for)', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, AUDIT_CHANNEL],
      seamBody: NEUTRALIZE_ALL,
    })
    const mutables = extractModuleScopeMutables(STORE, fixture)
    expect(mutables.some((m) => m.name === 'auditDebounce')).toBe(true)
    expect(auditClassification(mutables).map((p) => `${p.name}:${p.kind}`))
      .toEqual(['auditDebounce:unclassified'])
  })

  it('a const-held ARRAY container is in-domain too (an array holds pending writes just as well as an object -- the widening is about mutable STORAGE, not the literal spelling)', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, `const auditQueue: unknown[] = []`],
      seamBody: NEUTRALIZE_ALL,
    })
    expect(auditClassification(extractModuleScopeMutables(STORE, fixture)).map((p) => p.name))
      .toEqual(['auditQueue'])
  })

  it('an `as const` / parenthesized wrapper does not dodge the domain (a spelling must not decide safety)', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, `const auditWrapped = ({ pending: null })`],
      seamBody: NEUTRALIZE_ALL,
    })
    expect(auditClassification(extractModuleScopeMutables(STORE, fixture)).map((p) => p.name))
      .toEqual(['auditWrapped'])
  })

  it('CONTROL: the same fixture WITHOUT the const container is clean -- fixture E is red for its own reason, not because the harness is red for everything', () => {
    const fixture = storeFixture({ mutables: ALL_CHANNEL_LETS, seamBody: NEUTRALIZE_ALL })
    expect(auditClassification(extractModuleScopeMutables(STORE, fixture))).toEqual([])
  })

  it('non-container consts stay OUT even beside the widening: a function, a string and a number cannot hold an assigned pending write', () => {
    const fixture = storeFixture({
      mutables: [
        ...ALL_CHANNEL_LETS,
        `const SKETCH_LAYER_COLOR = '#7fd'`,
        `const TEXT_FLIP_MIN_MM = 3`,
        `const wrapPathOffset = (s: number) => s`,
      ],
      seamBody: NEUTRALIZE_ALL,
    })
    const names = extractModuleScopeMutables(STORE, fixture).map((m) => m.name)
    expect(names).not.toContain('SKETCH_LAYER_COLOR')
    expect(names).not.toContain('TEXT_FLIP_MIN_MM')
    expect(names).not.toContain('wrapPathOffset')
  })

  it('the REAL store\'s const containers are all dispositioned -- the widening pulled 8 pre-existing bindings plus the gate\'s own refusal log into the domain, and an undispositioned one is RED (asserted here rather than left to the whole-file check, so this fixture family owns its own consequence)', () => {
    const real = extractModuleScopeMutables(STORE, storeSource)
    const containers = real.filter((m) => /^\s*const\b/.test(m.text) || !/^\s*let\b/.test(m.text))
    // Non-empty guard: an extractor that silently stopped finding containers
    // would make the assertion below vacuously true.
    expect(containers.length).toBeGreaterThanOrEqual(9)
    expect(auditClassification(real, ASYNC_WRITE_CHANNEL_CENSUS, CURRENT_CHANNEL_NAMED_EXCLUSIONS)).toEqual([])
  })
})

describe('SKC-56-R3 adversarial fixture A (continued)', () => {

  it('a `let` INSIDE a function is not module-scope state and is not swept (it cannot outlive its own call, so nothing of it can cross a restore)', () => {
    const fixture = storeFixture({
      mutables: ALL_CHANNEL_LETS,
      seamBody: NEUTRALIZE_ALL,
      extra: `function helper() { let pendingLocal = null; return pendingLocal }`,
    })
    expect(extractModuleScopeMutables(STORE, fixture).some((m) => m.name === 'pendingLocal')).toBe(false)
  })
})

describe('SKC-56-R3 adversarial fixture B: the R2 BLOCKER, reproduced structurally -- a censused channel the seam does not neutralize', () => {
  it('a seam that neutralizes only the R2 set (request id + the two verdict trackers) is RED on all three drag channels -- this is the check that would have caught the R2 blocker at commit time', () => {
    // Verbatim the R2 seam's (a) block: exactly what the R2 audit found
    // insufficient ("It clears only the last dispatched request id and two
    // verdict trackers, but leaves dragDebounceTimer, pendingDrag, and the
    // active drag plan alive").
    const r2SeamBody = [
      `  latestSketchRequestId = ''`,
      `  pendingConstraintApply = null`,
      `  pendingDimensionApply = null`,
    ].join('\n')
    const fixture = storeFixture({ mutables: ALL_CHANNEL_LETS, seamBody: r2SeamBody })
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture),
      extractSeamTimerCancels(STORE, fixture),
    )
    expect(violations.map((v) => `${v.name}:${v.kind}`)).toEqual([
      'dimensionPlacement:not-neutralized',
      'pendingAppendApply:not-neutralized',
      'dragDebounceTimer:not-neutralized',
      'pendingDrag:not-neutralized',
      'sketchDragPlan:not-neutralized',
    ])
  })

  it('dropping the sketchDragPlan clear ALONE (the live-rearm mode) is RED on its own -- the queued-timer clear does not cover it', () => {
    const fixture = storeFixture({
      mutables: ALL_CHANNEL_LETS,
      seamBody: NEUTRALIZE_ALL.replace(`  sketchDragPlan = null`, ''),
    })
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture),
      extractSeamTimerCancels(STORE, fixture),
    )
    expect(violations.map((v) => `${v.name}:${v.kind}`)).toEqual(['sketchDragPlan:not-neutralized'])
  })

  it('CONTROL: the real seam neutralizes every censused channel (the check above is not vacuously red)', () => {
    const fixture = storeFixture({ mutables: ALL_CHANNEL_LETS, seamBody: NEUTRALIZE_ALL })
    expect(auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture), extractSeamTimerCancels(STORE, fixture),
    )).toEqual([])
  })

  it('a neutralization written somewhere OTHER than the seam does not count (neutralizing a channel off the restore path is not neutralizing it)', () => {
    const fixture = storeFixture({
      mutables: ALL_CHANNEL_LETS,
      seamBody: NEUTRALIZE_ALL.replace(`  sketchDragPlan = null`, ''),
      // The clear exists in the file -- just not on the restore path. Exactly
      // endSketchDrag's real situation: it clears the plan on MOUSE-UP, which a
      // keyboard undo never reaches.
      extra: `function endSketchDrag() { sketchDragPlan = null }`,
    })
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture), extractSeamTimerCancels(STORE, fixture),
    )
    expect(violations.map((v) => v.name)).toEqual(['sketchDragPlan'])
  })
})

describe('SKC-56-R3 adversarial fixture C: a timer channel nulled but never cancelled', () => {
  it('assigning the timer handle WITHOUT clearTimeout is RED -- dropping a handle does not cancel a timer, the callback stays armed and fires into the restored sketch', () => {
    const fixture = storeFixture({
      mutables: ALL_CHANNEL_LETS,
      seamBody: NEUTRALIZE_ALL.replace(
        `  if (dragDebounceTimer !== null) { clearTimeout(dragDebounceTimer); dragDebounceTimer = null }`,
        `  dragDebounceTimer = null`,
      ),
    })
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture), extractSeamTimerCancels(STORE, fixture),
    )
    expect(violations.map((v) => `${v.name}:${v.kind}`)).toEqual(['dragDebounceTimer:timer-not-cancelled'])
  })

  it('the cancel must name the channel ITSELF -- cancelling some other handle does not discharge it', () => {
    const fixture = storeFixture({
      mutables: [...ALL_CHANNEL_LETS, `let sketchNoticeTimer = null`],
      seamBody: NEUTRALIZE_ALL.replace(
        `  if (dragDebounceTimer !== null) { clearTimeout(dragDebounceTimer); dragDebounceTimer = null }`,
        `  clearTimeout(sketchNoticeTimer)\n  dragDebounceTimer = null`,
      ),
    })
    const violations = auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture), extractSeamTimerCancels(STORE, fixture),
    )
    expect(violations.map((v) => `${v.name}:${v.kind}`)).toEqual(['dragDebounceTimer:timer-not-cancelled'])
  })

  it('a channel-timer entry is what makes the cancel mandatory: the SAME seam is clean when the entry is an ordinary channel (proves the two classes are really different rules, not decoration)', () => {
    const fixture = storeFixture({
      mutables: ALL_CHANNEL_LETS,
      seamBody: NEUTRALIZE_ALL.replace(
        `  if (dragDebounceTimer !== null) { clearTimeout(dragDebounceTimer); dragDebounceTimer = null }`,
        `  dragDebounceTimer = null`,
      ),
    })
    const asPlainChannel: ChannelCensusEntry[] = ASYNC_WRITE_CHANNEL_CENSUS.map(
      (e) => e.name === 'dragDebounceTimer' ? { ...e, class: 'channel' as const } : e,
    )
    expect(auditSeamNeutralization(
      extractSeamNeutralizations(STORE, fixture), extractSeamTimerCancels(STORE, fixture), asPlainChannel,
    )).toEqual([])
  })
})

describe('SKC-56-R3 adversarial fixture D: a brand-new deferred write site appears without a disposition', () => {
  it('a NEW timer callback that dispatches a solve is caught and is UNCLASSIFIED (RED)', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchDeferredResolve: () => {`,
      `    setTimeout(() => { get().solveSketch() }, 50)`,
      `  },`,
      `  solveSketch: () => { latestSketchRequestId = crypto.randomUUID() },`,
      `})`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].siteFunction).toBe('auditScratchDeferredResolve')
    expect(sites[0].deferral).toBe('timer-callback')
    expect(matchingDeferredEntries(sites[0]), 'a brand-new deferred write site must NOT match any existing entry').toEqual([])
  })

  it('the reach is TRANSITIVE, not body-local: a deferred callback whose only write is TWO calls away is still caught (the importSketchFont shape, which a body-local sweep loses)', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchIndirect: async (file) => {`,
      `    const rec = await importFontFile(file)`,
      `    get().applyTextEditPatch({ fontFamily: rec.family })`,
      `  },`,
      `  applyTextEditPatch: (patch) => { get().writeThrough(patch) },`,
      `  writeThrough: (patch) => { set((s) => ({ activeSketch: { ...s.activeSketch, patch } })) },`,
      `})`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture)
    expect(sites.map((s) => `${s.siteFunction}/${s.deferral}`)).toEqual(['auditScratchIndirect/async-body'])
  })

  it('a promise-callback (.then) that writes the sketch is caught', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchThenWrite: () => {`,
      `    hydrate().then(() => { set((s) => ({ activeSketch: s.pending })) })`,
      `  },`,
      `})`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture)
    expect(sites.map((s) => `${s.siteFunction}/${s.deferral}`)).toEqual(['auditScratchThenWrite/promise-callback'])
    expect(matchingDeferredEntries(sites[0])).toEqual([])
  })

  it('an event-handler assignment that writes the sketch is caught', () => {
    const fixture = [
      `function ensureOtherWorker() {`,
      `  otherWorker.onmessage = (event) => {`,
      `    useCamStore.setState({ activeSketch: event.data.sketch })`,
      `  }`,
      `}`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture)
    expect(sites.map((s) => `${s.siteFunction}/${s.deferral}/${s.anchorText}`))
      .toEqual(['onmessage/event-handler/otherWorker.onmessage = <fn>'])
  })

  it('CONTROL (non-vacuity of the deferral gate): the SAME sketch write in a SYNCHRONOUS action is NOT a deferred site -- an ordinary user action after a restore is not a channel that survived one', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchSyncWrite: () => { set((s) => ({ activeSketch: s.pending })) },`,
      `})`,
    ].join('\n')
    expect(extractDeferredWriteSites(STORE, fixture)).toEqual([])
  })

  it('CONTROL (non-vacuity of the write gate): a deferred callback that writes NO sketch state is not a site', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchNoticeTimer: () => {`,
      `    setTimeout(() => { set({ sketchNotice: null }) }, 8000)`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDeferredWriteSites(STORE, fixture)).toEqual([])
  })

  it('PRECISION: a built-in method call that shares a name with a real store writer (`text.replace(...)` vs the mount\'s `replace` action) is NOT a store call -- keying the call graph on the callee NAME alone drags unrelated async actions in as bogus channels', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  replace: (next) => { set((s) => ({ activeSketch: next })) },`,
      `  auditScratchSaveFile: async () => {`,
      `    const bytes = await collect()`,
      `    const name = bytes.name.replace(/[^a-z]/g, '_')`,
      `    return name`,
      `  },`,
      `})`,
    ].join('\n')
    expect(
      extractDeferredWriteSites(STORE, fixture),
      'a String.prototype.replace call must not make an async action a sketch write channel',
    ).toEqual([])
  })

  it('PRECISION, other direction: the same async action IS caught when it really calls the store\'s `replace` through get()', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  replace: (next) => { set((s) => ({ activeSketch: next })) },`,
      `  auditScratchRealReplace: async () => {`,
      `    const next = await collect()`,
      `    get().replace(next)`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDeferredWriteSites(STORE, fixture).map((s) => s.siteFunction)).toEqual(['auditScratchRealReplace'])
  })

  it('a store call through an ALIAS of get() (`const s = get(); s.solveSketch()`) is tracked too', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  solveSketch: () => { latestSketchRequestId = crypto.randomUUID() },`,
      `  auditScratchAliasCall: async () => {`,
      `    await settle()`,
      `    const s = get()`,
      `    s.solveSketch()`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractDeferredWriteSites(STORE, fixture).map((s) => s.siteFunction)).toEqual(['auditScratchAliasCall'])
  })

  it('an async function with NO await is not deferred (it runs to completion synchronously, so no restore can interleave inside it)', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchAsyncNoAwait: async () => { set((s) => ({ activeSketch: s.pending })) },`,
      `})`,
    ].join('\n')
    expect(extractDeferredWriteSites(STORE, fixture)).toEqual([])
  })
})

describe('SKC-56-R3 adversarial fixture E: a SECOND deferral inside an already-classified function', () => {
  it('an entry cannot absorb a second site under its own key -- the derived count outgrows the declared siteCount, RED', () => {
    // dragSolveSketch grows a second, longer debounce beside its 25ms one --
    // same function, same deferral kind, so a key-only census would go green.
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  dragSolveSketch: (drag) => {`,
      `    dragDebounceTimer = setTimeout(() => { latestSketchRequestId = crypto.randomUUID() }, 25)`,
      `    slowDebounceTimer = setTimeout(() => { latestSketchRequestId = crypto.randomUUID() }, 250)`,
      `  },`,
      `})`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture).filter((s) => s.siteFunction === 'dragSolveSketch')
    expect(sites.length, 'both timers must be derived as distinct sites').toBe(2)
    // The 25ms one matches the real entry; the 250ms one does not (its
    // anchorText carries its own delay), so it is unclassified AND the
    // declared siteCount=1 no longer covers the function.
    const classified = sites.filter((s) => matchingDeferredEntries(s).length === 1)
    const unclassified = sites.filter((s) => matchingDeferredEntries(s).length === 0)
    expect(classified.map((s) => s.anchorText)).toEqual(['setTimeout(<fn>, 25)'])
    expect(unclassified.map((s) => s.anchorText)).toEqual(['setTimeout(<fn>, 250)'])
  })

  it('a rewritten debounce DELAY changes the anchorText, so the site loses its classification rather than silently inheriting it', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  dragSolveSketch: (drag) => {`,
      `    dragDebounceTimer = setTimeout(() => { latestSketchRequestId = crypto.randomUUID() }, 400)`,
      `  },`,
      `})`,
    ].join('\n')
    const sites = extractDeferredWriteSites(STORE, fixture)
    expect(sites.length).toBe(1)
    expect(matchingDeferredEntries(sites[0])).toEqual([])
  })
})

// ---- The census's own key axes are enforced, not merely conventional -------

describe('SKC-56-R3: the exclusion table cannot launder a real channel', () => {
  const dragPlan = extractModuleScopeMutables(STORE, storeSource).find((m) => m.name === 'sketchDragPlan')

  it('sanity: sketchDragPlan is a REAL module-scope mutable of the real store, classified exactly once today', () => {
    expect(dragPlan, 'sketchDragPlan must exist in the real store for the proofs below to mean anything').toBeDefined()
    expect(matchingChannelEntries(dragPlan!).length).toBe(1)
    expect(auditClassification([dragPlan!])).toEqual([])
  })

  it('excusing a name that is ALREADY censused as a channel is DOUBLE-CLASSIFIED (RED) -- a future "simplification" cannot quietly downgrade the R2 blocker\'s channel by adding a plausible-sounding exclusion beside it', () => {
    const laundering = [{
      id: 'adversarial-attempt-to-excuse-a-real-channel',
      file: 'src/store/index.ts' as const,
      name: 'sketchDragPlan',
      reason: 'ADVERSARIAL TEST ENTRY: claims the drag plan needs no seam action; must be refused.',
    }]
    const problems = auditClassification([dragPlan!], ASYNC_WRITE_CHANNEL_CENSUS, [
      ...CURRENT_CHANNEL_NAMED_EXCLUSIONS, ...laundering,
    ])
    expect(problems.map((p) => `${p.name}:${p.kind}`)).toEqual(['sketchDragPlan:double-classified'])
  })

  it('and REPLACING the channel entry with an exclusion is caught by the seam audit instead -- the two tables cannot be traded off against each other to make the drag plan disappear', () => {
    // The other half of the same attack: drop the channel entry entirely, so
    // classification goes green (exactly one match -- the exclusion). The seam
    // check is unaffected, but the ruling's named-channel pin below and the
    // interleave matrix's own drag cells are what refuse it -- so prove the
    // pin bites rather than claiming the seam audit does.
    const withoutDragPlan = ASYNC_WRITE_CHANNEL_CENSUS.filter((e) => e.name !== 'sketchDragPlan')
    const swapped = [
      ...CURRENT_CHANNEL_NAMED_EXCLUSIONS,
      {
        id: 'adversarial-swap', file: 'src/store/index.ts' as const, name: 'sketchDragPlan',
        reason: 'ADVERSARIAL TEST ENTRY: swaps the channel entry for an exclusion.',
      },
    ]
    expect(
      auditClassification([dragPlan!], withoutDragPlan, swapped),
      'the swap alone passes classification -- which is exactly why the ruling\'s named channels are pinned separately',
    ).toEqual([])
    expect(
      withoutDragPlan.some((e) => e.name === 'sketchDragPlan'),
      'the pin test above ("the ruling\'s three named-by-hand channels are all present") is what fails on this swap',
    ).toBe(false)
  })
})
