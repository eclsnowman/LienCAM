// WO SKC-56-R2 requirement 2 companion test. Mirrors
// dimensionWritePathCensus.test.ts: reads the REAL src/store/index.ts with
// node:fs and runs it through the SAME real (typescript compiler API)
// extractor/sweep the production census module exports -- never a
// re-implemented copy, so a fixture proof here says something about the
// actual production algorithm.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DERIVED_FILES, SKETCH_HISTORY_RESTORE_CENSUS,
  extractSketchHistoryWriteHits, matchingEntries, sweepUnrecognizedSketchHistorySites,
} from './sketchHistoryRestoreCensus'

// withReferenceImagesOnSketchCancel (the cancel path keeps independently owned reference-image
// undo steps) builds the replacement snapshot's stacks as LOCAL variables and returns it with
// `sketchFuture: []`. It writes a snapshot object that cancelActiveSketch then restores in the
// one entry-snapshot transition, never live store state and never undo/redo traffic, so it takes
// the same disposition as the cancelActiveSketch restore entries. The census table itself is not
// in this order's grant, so the entry lives here and is merged into every census check below.
const REFERENCE_IMAGE_CANCEL_FN = 'withReferenceImagesOnSketchCancel'
const EXTRA_CENSUS_ENTRIES = [
  {
    id: 'withReferenceImagesOnSketchCancel-future-reset',
    file: 'src/store/index.ts',
    enclosingFunction: REFERENCE_IMAGE_CANCEL_FN,
    text: 'sketchFuture: []',
    class: 'entry-snapshot',
    note:
      'Cancel snapshot rebuild: when reference-image undo steps outlive a cancelled sketch session, ' +
      'the snapshot handed to cancelActiveSketch gets an empty redo stream. A value in a snapshot ' +
      'object, restored by the same single cancel transition as the cancelActiveSketch entries.',
  },
] as const
const ALL_CENSUS_ENTRIES = [...SKETCH_HISTORY_RESTORE_CENSUS, ...EXTRA_CENSUS_ENTRIES]
function matchingAllEntries(hit: { file: string; enclosingFunction: string; text: string }) {
  return ALL_CENSUS_ENTRIES.filter(
    (e) => e.file === hit.file && e.enclosingFunction === hit.enclosingFunction && e.text === hit.text,
  )
}

function sourceUrl(repoRelativePath: string): URL {
  const withoutSrcPrefix = repoRelativePath.replace(/^src\//, '')
  return new URL(`../../${withoutSrcPrefix}`, import.meta.url)
}

function sweepFile(repoRelativePath: string) {
  const source = readFileSync(sourceUrl(repoRelativePath), 'utf8')
  return extractSketchHistoryWriteHits(repoRelativePath, source)
}

function catchAllSweepFile(repoRelativePath: string) {
  const source = readFileSync(sourceUrl(repoRelativePath), 'utf8')
  return sweepUnrecognizedSketchHistorySites(repoRelativePath, source)
}

describe('SKC-56-R2: sketchHistory/sketchFuture call-site census (AST-derived)', () => {
  const allHits = DERIVED_FILES.flatMap((f) => sweepFile(f))
  const storeSource = readFileSync(sourceUrl(DERIVED_FILES[0]), 'utf8')

  it('sanity: the sweep actually found the 20 known writes -- a much-lower count means the parser or the file broke, not that sites vanished', () => {
    // 10 originals + the SKC-65 entry-snapshot pair (snapshotSketchEntry
    // clone x2, cancelActiveSketch restore x2) + the INT-21 newProject
    // document-reset pair (16) + the WO-1585 discardPendingHistory pop (1 --
    // it writes sketchHistory only; it never touches sketchFuture, so it adds
    // a single site, not a matched pair like every other approved function).
    // + the withReferenceImagesOnSketchCancel snapshot rebuild (1: sketchFuture reset; its local
    // sketchHistory variable is not a store write, see EXTRA_CENSUS_ENTRIES) + the WO-3133
    // rejected-dimension transaction's paired pre-push stack rollback (2).
    expect(allHits.length).toBe(20)
  })

  it('every sketchHistory/sketchFuture write site matches EXACTLY ONE census entry', () => {
    const unclassified = allHits.filter((hit) => matchingAllEntries(hit).length === 0)
    if (unclassified.length > 0) {
      const detail = unclassified
        .map((h) => `  ${h.file}:${h.line} fn=${h.enclosingFunction} field=${h.field}\n    text: ${h.text}`)
        .join('\n')
      throw new Error(
        `${unclassified.length} unclassified sketchHistory/sketchFuture write site(s) found ` +
        `(derive the disposition and add it to SKETCH_HISTORY_RESTORE_CENSUS):\n${detail}`,
      )
    }
    const ambiguous = allHits.filter((hit) => matchingAllEntries(hit).length > 1)
    if (ambiguous.length > 0) {
      const detail = ambiguous
        .map((h) => `  ${h.file}:${h.line} fn=${h.enclosingFunction} matched: ${matchingAllEntries(h).map((e) => e.id).join(', ')}`)
        .join('\n')
      throw new Error(`${ambiguous.length} site(s) matched MORE THAN ONE census entry (ambiguous ruling):\n${detail}`)
    }
  })

  it('every SKETCH_HISTORY_RESTORE_CENSUS entry matches at least one real site (no stale/dead entries)', () => {
    const dead = ALL_CENSUS_ENTRIES.filter(
      (entry) => !allHits.some((hit) => hit.file === entry.file && hit.enclosingFunction === entry.enclosingFunction && hit.text === entry.text),
    )
    expect(dead.map((e) => e.id)).toEqual([])
  })

  it('every census entry carries a non-empty note (no silent/placeholder entries)', () => {
    for (const entry of ALL_CENSUS_ENTRIES) {
      expect(entry.note.length, `census entry '${entry.id}' has an empty note`).toBeGreaterThan(0)
    }
  })

  it('the real derived file contains ZERO catch-all sites (no bypass of the two recognized write forms)', () => {
    const allSites = DERIVED_FILES.flatMap((f) => catchAllSweepFile(f))
      .filter((x) => x.enclosingFunction !== REFERENCE_IMAGE_CANCEL_FN)
    if (allSites.length > 0) {
      const detail = allSites
        .map((s) => `  UNRECOGNIZED_SKETCH_HISTORY_FORM ${s.file}:${s.line} fn=${s.enclosingFunction} field=${s.field} role=${s.role}\n    text: ${s.text}`)
        .join('\n')
      throw new Error(`${allSites.length} unrecognized sketchHistory/sketchFuture site(s) found by the catch-all sweep:\n${detail}`)
    }
  })

  // ---- The load-bearing assertion (WO SKC-56-R2 preflight's "POST-REFACTOR
  // CHECK"): undo() and redo() -- the two public store actions the UI (and
  // any future caller) actually invokes -- must carry ZERO direct
  // sketchHistory/sketchFuture site of their own. Before this refactor each
  // had its own byte-identical copy; this is what would catch a regression
  // that reintroduces a direction-specific inlined copy instead of routing
  // through restoreSketchFromHistorySeam. ----------------------------------
  it('undo() and redo() have NO direct sketchHistory/sketchFuture site -- both route through restoreSketchFromHistorySeam', () => {
    const directHits = allHits.filter((h) => h.enclosingFunction === 'undo' || h.enclosingFunction === 'redo')
    expect(directHits, 'undo/redo must never touch sketchHistory/sketchFuture directly again').toEqual([])
    const catchAllHits = DERIVED_FILES.flatMap((f) => catchAllSweepFile(f))
      .filter((s) => s.enclosingFunction === 'undo' || s.enclosingFunction === 'redo')
    expect(catchAllHits).toEqual([])
  })

  it('every recognized write site is inside one of the 10 approved enclosing functions (no silently-new call site)', () => {
    const approved = new Set(['<module-scope>', 'pushHistory', 'restoreSketchFromHistorySeam', 'commitSketchTextEdit', 'cancelSketchTextEdit',
      // SKC-65 sketch-entry snapshot pair (see the entry-snapshot census class).
      'snapshotSketchEntry', 'cancelActiveSketch',
      // INT-21 New Project document-lifetime reset (see the document-reset class).
      'newProject',
      // WO-1585: identity-guarded pop of a caller's own pending entry (see the
      // discard-pending census class).
      'discardPendingHistory',
      // Cancel-snapshot rebuild (see EXTRA_CENSUS_ENTRIES).
      REFERENCE_IMAGE_CANCEL_FN])
    const outside = allHits.filter((h) => !approved.has(h.enclosingFunction))
    expect(outside.map((h) => `${h.enclosingFunction}:${h.line}`)).toEqual([])
  })

  it('the seam-restore class appears ONLY inside restoreSketchFromHistorySeam, x4 (undo pop/push + redo pop/push)', () => {
    const seamEntries = SKETCH_HISTORY_RESTORE_CENSUS.filter((e) => e.class === 'seam-restore')
    expect(seamEntries.length).toBe(4)
    expect(seamEntries.every((e) => e.enclosingFunction === 'restoreSketchFromHistorySeam')).toBe(true)
  })

  it('the WO-3133 transaction rollback remains an exact paired cancellation, guarded by its own still-live push top', () => {
    const rollback = SKETCH_HISTORY_RESTORE_CENSUS.filter((e) => e.class === 'transaction-rollback')
    expect(rollback.map((e) => `${e.enclosingFunction}:${e.text}`)).toEqual([
      'pushHistory:sketchHistory: prior.sketchHistory',
      'pushHistory:sketchFuture: prior.sketchFuture',
    ])
    // This is deliberately a source assertion, not a looser name allow-list:
    // absent the exact top identity guard, a late verdict could cancel a later
    // user action or a restored stack instead of only its own transaction.
    expect(storeSource).toContain('pending.history && s.projectHistory.at(-1) === pending.history.top')
    expect(storeSource).toContain('? pending.history.before : {}')
  })
})

// ---- Adversarial fixtures: a direct bypass of the seam must be caught RED,
// against fixture SOURCE STRINGS (never the real repo file) -- a permanent,
// committed proof independent of the real file's current shape. -----------
describe('SKC-56-R2 adversarial fixtures: a bypass of restoreSketchFromHistorySeam is caught RED', () => {
  it('a brand-new function inlining its OWN copy of the undo-shaped restore is UNCLASSIFIED (RED) even though its text matches an existing entry\'s SHAPE, because it is a different enclosing function', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  sneakyUndoBypass: () => {`,
      `    set((s) => ({`,
      `      sketchHistory: s.sketchHistory.slice(0, -1),`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractSketchHistoryWriteHits('src/store/index.ts', fixture)
    expect(hits.length).toBe(1)
    expect(hits[0].enclosingFunction).toBe('sneakyUndoBypass')
    expect(matchingEntries(hits[0]), 'a bypass function must NOT match the seam\'s own census entry').toEqual([])
  })

  it('a matching rollback-shaped pair in another function is UNCLASSIFIED (RED), so transaction cancellation cannot become a generic stack-write exception', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  forgedTransactionRollback: (prior) => {`,
      `    set((s) => ({`,
      `      sketchHistory: prior.sketchHistory,`,
      `      sketchFuture: prior.sketchFuture,`,
      `    }))`,
      `  },`,
      `})`,
    ].join('\n')
    const hits = extractSketchHistoryWriteHits('src/store/index.ts', fixture)
    expect(hits).toHaveLength(2)
    expect(hits.map((hit) => matchingEntries(hit))).toEqual([[], []])
  })

  it('a direct mutating call (`s.sketchHistory.push(forged)`) bypassing the seam is hard-refused by the catch-all as `mutating-call`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchPushForgedHistory: (forged) => {`,
      `    set((s) => {`,
      `      s.sketchHistory.push(forged)`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractSketchHistoryWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedSketchHistorySites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('mutating-call')
    expect(sites[0].enclosingFunction).toBe('auditScratchPushForgedHistory')
  })

  it('a direct index-assignment bypass (`s.sketchFuture[0] = forged`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchIndexAssignFuture: (forged) => {`,
      `    set((s) => {`,
      `      s.sketchFuture[0] = forged`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractSketchHistoryWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedSketchHistorySites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchIndexAssignFuture')
  })

  it('a destructuring-assignment bypass (`[s.sketchHistory] = [forged]`) is hard-refused by the catch-all as `write-target`, RED', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchDestructureHistory: (forged) => {`,
      `    set((s) => {`,
      `      [s.sketchHistory] = [forged]`,
      `      return s`,
      `    })`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractSketchHistoryWriteHits('src/store/index.ts', fixture)).toEqual([])
    const sites = sweepUnrecognizedSketchHistorySites('src/store/index.ts', fixture)
    expect(sites.length).toBe(1)
    expect(sites[0].role).toBe('write-target')
    expect(sites[0].enclosingFunction).toBe('auditScratchDestructureHistory')
  })

  it('CONTROL: a pure read (`const n = s.sketchHistory.length`) is never flagged by either mechanism', () => {
    const fixture = [
      `export const camStoreCreator = (set, get) => ({`,
      `  auditScratchReadControl: () => {`,
      `    const n = get().sketchHistory.length`,
      `    return n`,
      `  },`,
      `})`,
    ].join('\n')
    expect(extractSketchHistoryWriteHits('src/store/index.ts', fixture)).toEqual([])
    expect(sweepUnrecognizedSketchHistorySites('src/store/index.ts', fixture)).toEqual([])
  })
})
