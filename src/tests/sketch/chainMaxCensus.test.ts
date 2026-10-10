// SKC-46-R2 (two-bounce STOP close-out): the chain-max discriminated union census.
//
// The R1 audit found the fillet/chamfer size-seeding path treated an all-unresolvable staged
// chain (collinear/degenerate corners) the SAME as "no corner geometry known yet" -- both
// collapsed to a bare `null`, and `null` was an ACCEPT. R0 and R1 both guarded the states the
// AUDITOR named and missed the states nobody named (a NaN/Infinity ceiling sailing through every
// existing numeric guard). The R2 fix derives the accept/refuse domain from the type contract
// (`ChainMaxResult`, `classifyChainMax`, `seedStagedSize` in stagedSizeDrag.ts) instead of patching
// named repros -- this file is the census that proves the derivation cannot be gamed:
//
//   1. a VALUE-LEVEL registry <-> TYPE union two-way bridge (a kind added to one but not the
//      other fails tsc in ONE of the two directions -- proven by keeping the bridge consts live).
//   2. a constructor property test over the FULL adversarial numeric set the preflight derived.
//   3. an expectation-table walk of EVERY registered kind through the REAL `seedStagedSize` --
//      this is the runtime census: adding a kind to `CHAIN_MAX_KINDS` without adding its row here
//      is a RED vitest failure naming the kind (see `it('every registered kind ...')` below).
//   4. a forged out-of-registry kind, asserted fail-closed (never silently accepted).
//   5. a source-level grep gate: no `default:` arm in the seed/patch variant handling accepts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAIN_MAX_KINDS,
  CHAIN_MAX_KIND_BRIDGE_REGISTRY_TO_UNION,
  CHAIN_MAX_KIND_BRIDGE_UNION_TO_REGISTRY,
  classifyChainMax,
  derivedGrabbableDefault,
  seedStagedSize,
  type ChainMaxKind,
  type ChainMaxResult,
} from '../../lib/sketch/tools/stagedSizeDrag'
import * as stagedSizeDragModule from '../../lib/sketch/tools/stagedSizeDrag'
import { bindSketcherDocument, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketchDocumentPort } from '../../lib/sketch/sketcher/ports'
import * as filletToolModule from '../../lib/sketch/tools/filletTool'
import * as chamferToolModule from '../../lib/sketch/tools/chamferTool'
import type { FilletChainState } from '../../lib/sketch/tools/filletTool'
import type { ChamferChainState } from '../../lib/sketch/tools/chamferTool'
import type { Sketch, SketchEntity, Vec2 } from '../../lib/sketch/types'

const SRC_ROOT = join(__dirname, '..', '..')

// ---- Shared real-controller test fixtures (SKC-46-R3) --------------------------------------------
//
// Used by both the `stagedSizeSeedPatch` reachability census below and the +Infinity per-addition
// controller census further down -- a minimal (non-DOM) `SketchDocumentPort` fixture, the same
// "real controller, fake host" shape `sketcherLifecycle.test.ts` uses.
function makeLine(id: string, start: Vec2, end: Vec2): SketchEntity {
  return { id, kind: 'line', construction: false, start, end }
}

/** A right-angle corner at the origin with `arm`-mm legs: filletMaxUsableRadius resolves to
 *  roughly `arm` (finite-legal for a generous arm; sub-floor for an arm under ~0.012mm, since the
 *  fillet ceiling is `tan(45deg) * (arm - CEILING_MARGIN)` == `arm - 2e-6`). */
function rightAngleCorner(prefix: string, arm: number): [SketchEntity, SketchEntity] {
  return [
    makeLine(`${prefix}-a`, { x: 0, y: 0 }, { x: -arm, y: 0 }),
    makeLine(`${prefix}-b`, { x: 0, y: 0 }, { x: 0, y: arm }),
  ]
}

/** Two lines sharing an endpoint and pointing the SAME direction (theta === 0): the angle guard
 *  fires and the corner is `unresolvable` (requirement 2(a)'s exact construction). */
function collinearCorner(prefix: string): [SketchEntity, SketchEntity] {
  return [
    makeLine(`${prefix}-a`, { x: 0, y: 0 }, { x: -10, y: 0 }),
    makeLine(`${prefix}-b`, { x: 0, y: 0 }, { x: -5, y: 0 }),
  ]
}

interface Harness {
  doc: SketchDocumentPort
  sketch: Sketch
  selection: string[]
  notices: string[]
  lastSizes: { fillet: number | null; chamfer: number | null }
}

function makeHarness(entities: SketchEntity[]): Harness {
  const h = {
    sketch: {
      id: 'r3-census-sketch', layerId: 'l', entities, constraints: [], dimensions: [],
      solveStatus: null,
    } as Sketch,
    selection: [] as string[],
    notices: [] as string[],
    lastSizes: { fillet: null, chamfer: null } as { fillet: number | null; chamfer: number | null },
  }
  const doc: SketchDocumentPort = {
    getSketch: () => h.sketch,
    ensureSketch: () => h.sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => h.selection,
    setSelection: (ids) => { h.selection = ids },
    getLastStagedSize: (kind) => h.lastSizes[kind],
    setLastStagedSize: (kind, value) => { h.lastSizes[kind] = value },
    notice: (m) => { h.notices.push(m) },
    beginStep: () => {},
    append: (commit, inferred) => {
      h.sketch = {
        ...h.sketch,
        entities: [...h.sketch.entities, ...commit.entities],
        constraints: [...h.sketch.constraints, ...commit.constraints, ...inferred],
        dimensions: [...h.sketch.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: (next) => { h.sketch = { ...h.sketch, ...next } },
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => false,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }
  return Object.assign(h, { doc })
}

describe('SKC-46-R2: chain-max value-level registry <-> type union bridge', () => {
  it('both compile-time bridge directions are live `true` (a one-way drift fails tsc, not this test)', () => {
    // These consts only exist because `stagedSizeDrag.ts` types them as
    // `ChainMaxResult['kind'] extends ChainMaxKind ? true : never` and its mirror. If a kind is
    // ever added to ONE of {the union, the registry} and not the other, ONE of these two consts
    // stops type-checking as `true` and `npm run build` fails -- this assertion just proves the
    // bridge is actually referenced (not dead code an unused-var pass could silently drop).
    expect(CHAIN_MAX_KIND_BRIDGE_UNION_TO_REGISTRY).toBe(true)
    expect(CHAIN_MAX_KIND_BRIDGE_REGISTRY_TO_UNION).toBe(true)
  })

  it('the registry has exactly the 5 kinds the R2 derivation names -- no more, no fewer', () => {
    expect([...CHAIN_MAX_KINDS].sort()).toEqual(
      ['finite-legal', 'no-corner', 'non-finite', 'sub-floor', 'unresolvable'].sort(),
    )
  })

  // SKC-46-R3 (MAJOR 1 close-out): the compile-time bridge above (`_ChainMaxKindCoversUnion` /
  // `_RegistryCoversChainMaxKind`) proves the two directions match to `tsc` -- but a UNION-ONLY
  // drift (a new `| { kind: 'x' }` literal added to `ChainMaxResult` without touching
  // `CHAIN_MAX_KINDS`) left every runtime census below GREEN, because every one of them iterates
  // `CHAIN_MAX_KINDS` (the registry) and never independently discovers what the UNION itself
  // contains -- types are erased at runtime, so there is nothing to iterate. The R2 auditor proved
  // this with a no-file mutation: adding a scratch kind to the union alone left all 25 census
  // Vitests green (chainMaxCensus.test.ts audit finding, SKC-46-R2.audit.json). The only way to
  // give the union side a RUNTIME (not `tsc`-only) presence is to parse it out of the source text
  // independently of the registry, the same source-level technique the grep gate below already
  // uses for the `default:` arms. This is that independent enumeration.
  it('the ChainMaxResult union (parsed from source, independent of the registry) has exactly the registry\'s kinds -- either one-sided drift is a named RED here, not just a tsc failure', () => {
    const src = readFileSync(join(SRC_ROOT, 'lib', 'sketch', 'tools', 'stagedSizeDrag.ts'), 'utf8')
    const unionStart = src.indexOf('export type ChainMaxResult =')
    expect(unionStart, 'ChainMaxResult union declaration not found -- source shape changed').toBeGreaterThanOrEqual(0)
    // CRLF-safe: this file (like the rest of the tree) may carry \r\n line endings, so the
    // end-of-union marker is located with a line-ending-agnostic regex, never a literal '\n\n'.
    const afterUnion = src.slice(unionStart)
    const endMatch = /\r?\n\r?\n\/\/ Two-way compile-time bridge/.exec(afterUnion)
    expect(endMatch, 'end-of-union marker not found -- source shape changed').not.toBeNull()
    const unionBlock = afterUnion.slice(0, endMatch!.index)
    // Every union member in this file is written `| { kind: '<literal>' ...}` -- this regex reads
    // the union's OWN literals off the page, with no dependency on CHAIN_MAX_KINDS whatsoever.
    const unionKinds = [...unionBlock.matchAll(/\|\s*\{\s*kind:\s*'([^']+)'/g)].map((m) => m[1])
    expect(unionKinds.length, 'no union members parsed -- regex is stale against the source shape').toBeGreaterThan(0)

    const registrySet = new Set<string>(CHAIN_MAX_KINDS)
    const unionSet = new Set(unionKinds)
    const unionOnly = unionKinds.filter((k) => !registrySet.has(k))
    const registryOnly = [...registrySet].filter((k) => !unionSet.has(k))
    expect(unionOnly, 'kinds present in the ChainMaxResult union but MISSING from CHAIN_MAX_KINDS').toEqual([])
    expect(registryOnly, 'kinds present in CHAIN_MAX_KINDS but MISSING from the ChainMaxResult union').toEqual([])
  })
})

// ---- Constructor gate: classifyChainMax over the preflight's adversarial input set -------------
//
// Per-corner ceilings are `number | null` at the source (filletMaxUsableRadius/
// chamferMaxUsableSetback): `null` is geometrically unresolvable, but the number itself can ALSO
// be NaN, +/-Infinity, or negative (every existing guard in filletTool.ts/chamferTool.ts lets a
// poisoned coordinate through silently -- every comparison with NaN is false). `classifyChainMax`
// is the ONLY function allowed to turn that raw value into a `ChainMaxResult`; this property test
// drives it across the exact set the preflight derived, single-corner (`[v]`), so `no-corner`
// never appears here (it requires a truly empty array, tested separately below).
describe('SKC-46-R2: classifyChainMax constructor gate (adversarial per-corner set)', () => {
  const cases: Array<{ label: string; input: number | null; expectKind: ChainMaxKind }> = [
    { label: 'null (geometrically unresolvable)', input: null, expectKind: 'unresolvable' },
    { label: 'NaN (poisoned coordinate)', input: NaN, expectKind: 'non-finite' },
    { label: '+Infinity', input: Infinity, expectKind: 'non-finite' },
    { label: '-Infinity (unrepresentable at source, must still refuse)', input: -Infinity, expectKind: 'non-finite' },
    { label: '-1 (unrepresentable at source, must still refuse)', input: -1, expectKind: 'sub-floor' },
    { label: '0 (zero-ceiling, folds into sub-floor by named ruling)', input: 0, expectKind: 'sub-floor' },
    { label: '0.0099999 (just under the 0.01mm floor)', input: 0.0099999, expectKind: 'sub-floor' },
    { label: '0.01 exactly (MIN_SIZE, an ACCEPT -- strict-less-than)', input: 0.01, expectKind: 'finite-legal' },
    { label: 'exact-max float class (3.9999999999999996, the auditor\'s repro)', input: 3.9999999999999996, expectKind: 'finite-legal' },
    { label: 'legal mid-range value (7.25)', input: 7.25, expectKind: 'finite-legal' },
  ]

  for (const { label, input, expectKind } of cases) {
    it(`${label} classifies to '${expectKind}', never to finite-legal unless truly legal`, () => {
      const result = classifyChainMax([input])
      expect(result.kind, `input=${input}`).toBe(expectKind)
      if (result.kind === 'finite-legal' || result.kind === 'sub-floor') {
        expect(Number.isFinite(result.value), `payload for input=${input} must be finite`).toBe(true)
        expect(result.value, `payload for input=${input} must be >= 0`).toBeGreaterThanOrEqual(0)
      }
      // NaN and +/-Infinity must NEVER classify to finite-legal, whatever else changes.
      if (input === null || !Number.isFinite(input)) {
        expect(result.kind).not.toBe('finite-legal')
      }
    })
  }

  it('an empty per-corner list is "no-corner", never conflated with "unresolvable" (the R1 BLOCKER)', () => {
    expect(classifyChainMax([])).toEqual({ kind: 'no-corner' })
  })

  it('a mixed [null, finite] list resolves to the finite value -- unresolvable corners are skipped in the aggregate', () => {
    expect(classifyChainMax([null, 5])).toEqual({ kind: 'finite-legal', value: 5 })
  })

  it('a mixed [NaN, finite] list POISONS the aggregate to non-finite -- NaN is never skipped like null', () => {
    // This is the mixed-chain aggregate hazard the R2 mixed-chain ruling (toolController.ts) exists
    // to catch per-ADDITION: the aggregate alone cannot tell WHICH corner is responsible.
    expect(classifyChainMax([NaN, 5])).toEqual({ kind: 'non-finite' })
    expect(classifyChainMax([5, NaN])).toEqual({ kind: 'non-finite' })
  })

  it('a mixed [+Infinity, finite] list silently absorbs the Infinity behind the finite sibling (named, not fixed here)', () => {
    // Math.min(finite, +Infinity) === finite -- an Infinity corner in a mixed batch disappears
    // behind a finite sibling in the AGGREGATE. This is exactly why the mixed-chain ruling checks
    // each ADDITION in isolation rather than trusting the aggregate alone (see toolController.ts /
    // mixedChainRuling.test.ts's NaN/Infinity-poisoned-sibling coverage).
    expect(classifyChainMax([Infinity, 5])).toEqual({ kind: 'finite-legal', value: 5 })
  })
})

// ---- Runtime census: every registered kind, driven through the REAL seedStagedSize -------------
describe('SKC-46-R2: seedStagedSize census (every registered kind, real function, committed table)', () => {
  // Committed expectation table, keyed by the VALUE-LEVEL registry (not the type) -- this is what
  // makes the census a runtime artifact rather than a type-level one. A kind present in
  // `CHAIN_MAX_KINDS` but missing here fails the `it.each` below by construction (`representative`
  // throws "no census fixture for kind").
  const representative: Record<ChainMaxKind, ChainMaxResult> = {
    'no-corner': { kind: 'no-corner' },
    unresolvable: { kind: 'unresolvable' },
    'non-finite': { kind: 'non-finite' },
    'sub-floor': { kind: 'sub-floor', value: 0.004 },
    'finite-legal': { kind: 'finite-legal', value: 12 },
  }
  const expectRefused: Record<ChainMaxKind, boolean> = {
    'no-corner': false,
    unresolvable: true,
    'non-finite': true,
    'sub-floor': true,
    'finite-legal': false,
  }

  for (const kind of CHAIN_MAX_KINDS) {
    it(`registered kind '${kind}' has a census fixture and matches its committed refuse/accept expectation`, () => {
      const fixture = representative[kind]
      // eslint-disable-next-line no-console -- census must NAME the kind on failure, not just fail
      if (!fixture) throw new Error(`SKC-46-R2 census: no fixture for registered kind '${kind}'`)
      const seed = seedStagedSize(null, fixture)
      expect(seed.refused, `kind='${kind}'`).toBe(expectRefused[kind])
      if (seed.refused) {
        expect(['unresolvable', 'non-finite', 'sub-floor'], `kind='${kind}' reasonKind`).toContain(seed.reasonKind)
      }
    })
  }

  it('a remembered size never rescues a refusal kind (unresolvable/non-finite/sub-floor)', () => {
    for (const kind of ['unresolvable', 'non-finite', 'sub-floor'] as const) {
      const seed = seedStagedSize(10, representative[kind])
      expect(seed.refused, `kind='${kind}'`).toBe(true)
    }
  })
})

// ---- Forged out-of-registry kind: must fail-closed, never silently accept -----------------------
describe('SKC-46-R2: a forged out-of-registry kind is refused fail-closed', () => {
  it('seedStagedSize throws (fail-closed) rather than accepting an unrecognized kind', () => {
    const forged = { kind: 'bogus-kind-never-registered' } as unknown as ChainMaxResult
    expect(() => seedStagedSize(null, forged)).toThrow(/unhandled chain-max kind/)
  })
})

// ---- Source-level grep gate: no default:accept arm in the seed/patch variant handling ----------
describe('SKC-46-R2: no default:accept arm exists in the variant handling (grep gate)', () => {
  // Comments stripped first (same helper shape as oneSketchPointerOwner.test.ts's capability
  // scans): a doc comment that mentions "default:" in prose must never trip or satisfy this gate.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }
  const stagedSizeDragSrc = stripComments(
    readFileSync(join(SRC_ROOT, 'lib', 'sketch', 'tools', 'stagedSizeDrag.ts'), 'utf8'),
  )
  const toolControllerSrc = stripComments(
    readFileSync(join(SRC_ROOT, 'lib', 'sketch', 'sketcher', 'toolController.ts'), 'utf8'),
  )

  // A CODE `default:` arm is `default:` immediately followed by a `return` statement (comment
  // prose stripped above never has this exact shape). The ONLY legal default arm in this tree
  // calls `assertNeverChainMaxKind`, which THROWS -- so the absence of an accepting default is
  // provable by requiring every real default arm's `return` to route through it.
  function defaultArmsAreAllAssertNever(src: string, file: string): void {
    const defaultIndices: number[] = []
    const re = /default\s*:\s*\r?\n\s*return\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) defaultIndices.push(m.index)
    expect(defaultIndices.length, `${file}: expected at least one exhaustive default arm`).toBeGreaterThan(0)
    for (const idx of defaultIndices) {
      const window = src.slice(idx, idx + 160)
      expect(window, `${file} default arm at offset ${idx} must route through assertNeverChainMaxKind`)
        .toMatch(/assertNeverChainMaxKind/)
      // And it must never be a same-window accept-shaped literal (refused: false).
      expect(window, `${file} default arm at offset ${idx} must not accept`).not.toMatch(/refused:\s*false/)
    }
  }

  it('stagedSizeDrag.ts: every default arm asserts never (no silent accept)', () => {
    defaultArmsAreAllAssertNever(stagedSizeDragSrc, 'stagedSizeDrag.ts')
  })

  it('toolController.ts: every default arm asserts never (no silent accept)', () => {
    defaultArmsAreAllAssertNever(toolControllerSrc, 'toolController.ts')
  })
})

// ---- SKC-46-R3 (MAJOR 1 close-out, part 2): stagedSizeSeedPatch driven through the REAL controller
//
// The R2 audit's other MAJOR 1 gap: the runtime census above drives only the exported
// `seedStagedSize` directly -- the private `stagedSizeSeedPatch` (toolController.ts), the actual
// site that decides what a LIVE armTool/click gesture does with each chain-max kind, had NO
// committed coverage at all. `stagedSizeSeedPatch` is not exported (by design -- it is an
// implementation detail of the controller), so it is driven here the only legitimate way: through
// its two real public entry points, `sketcherTools.armTool` and `sketcherTools.click`, against a
// minimal (non-DOM) `SketchDocumentPort` fixture -- the same "real controller, fake host" shape
// `sketcherOverlays.test.tsx` and `sketcherLifecycle.test.ts` already use.
//
// This is NOT a blind "hit all 5 kinds" exercise: two of the five are PROVABLY UNREACHABLE through
// stagedSizeSeedPatch's real call sites, by construction of the surrounding R2 mixed-chain gates,
// and the tests below prove that instead of assuming it:
//   * `no-corner`: both call sites guard `chain.corners.length > 0` before calling
//     `filletChainMaxRadius`/`chamferChainMaxSetback` at all, so the chain-level aggregate (the
//     only function that can produce `no-corner`) never runs with an empty chain from here.
//   * `unresolvable`: `filterMixedChainCorners` (arm) and `checkMixedChainAddition` (click) both
//     classify EVERY corner individually (`perCornerChainMax`) BEFORE the aggregate ever computes,
//     and drop/refuse any corner that classifies dead (unresolvable/non-finite) right there. Since
//     the aggregate only sees corners that already passed that per-corner gate, and a null
//     (unresolvable) per-corner value is what makes the AGGREGATE unresolvable (every corner null),
//     the aggregate can never see an all-null batch through these entry points: the last corner
//     added is always checked individually first, and a null one is refused before staging.
// `non-finite` IS reachable, but only via the exact hazard `classifyChainMax([+Infinity, 5])` names
// above: a corner already staged (and legal WHEN it was added) whose underlying geometry silently
// degrades between that addition and the NEXT one. The per-addition gates only ever check the
// corner being added right now, never re-verify corners already sitting in the chain -- so a stale
// poisoned sibling reaches the aggregate on the following addition. `sub-floor` and `finite-legal`
// are directly reachable on the very first corner. That is 3 of 5 kinds driven live plus 2 proven
// unreachable by construction (and still covered directly against the real `seedStagedSize` in the
// runtime census above) -- a stronger claim than "5 for 5" would be, because it is actually true.
describe('SKC-46-R3: stagedSizeSeedPatch (private controller function) driven through armTool/click', () => {
  beforeEach(() => {
    sketcherToolStore.__reset()
  })

  afterEach(() => {
    bindSketcherDocument(null)
    vi.restoreAllMocks()
  })

  it('sub-floor: a too-small preselected corner is REFUSED by the real stagedSizeSeedPatch (armTool) -- memory untouched, notice named', () => {
    const [a, b] = rightAngleCorner('subfloor', 0.005)
    const h = makeHarness([a, b])
    h.selection = [a.id, b.id]
    bindSketcherDocument(h.doc)

    sketcherTools.armTool('fillet')

    const state = sketcherToolStore.getState()
    expect(state.chain).toEqual({ kind: 'fillet', corners: [], pendingLineId: null, pendingClick: null })
    expect(state.filletRadius, 'sizePatch must be empty on refusal -- scalar unchanged').toBe(2)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatch(/too small to fillet/)
    expect(h.lastSizes.fillet, 'a refusal must never write remembered size').toBeNull()
  })

  it('finite-legal: a normal preselected corner is ACCEPTED and seeds filletRadius via the real stagedSizeSeedPatch (armTool)', () => {
    const [a, b] = rightAngleCorner('legal-arm', 20)
    const h = makeHarness([a, b])
    h.selection = [a.id, b.id]
    bindSketcherDocument(h.doc)

    sketcherTools.armTool('fillet')

    const state = sketcherToolStore.getState()
    const chain = state.chain as FilletChainState
    expect(chain.kind).toBe('fillet')
    expect(chain.corners).toHaveLength(1)
    expect(state.filletRadius).toBeGreaterThan(0)
    expect(state.filletRadius).toBeLessThanOrEqual(20)
    expect(h.notices).toHaveLength(0)
  })

  it('finite-legal via a CLICK addition also drives the real stagedSizeSeedPatch -- both controller entry points route through the same function', () => {
    const [a, b] = rightAngleCorner('legal-click', 20)
    const h = makeHarness([a, b])
    bindSketcherDocument(h.doc)

    sketcherTools.armTool('fillet') // no preselection -> empty chain -> the noop branch, not seedStagedSize
    expect(sketcherToolStore.getState().filletRadius).toBe(2)

    sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false)

    const state = sketcherToolStore.getState()
    const chain = state.chain as FilletChainState
    expect(chain.corners).toHaveLength(1)
    expect(state.filletRadius).toBeGreaterThan(0)
    expect(h.notices).toHaveLength(0)
  })

  it("chamfer finite-legal via armTool proves stagedSizeSeedPatch's chamfer branch runs too, not only fillet's", () => {
    const [a, b] = rightAngleCorner('chamfer-legal', 20)
    const h = makeHarness([a, b])
    h.selection = [a.id, b.id]
    bindSketcherDocument(h.doc)

    sketcherTools.armTool('chamfer')

    const state = sketcherToolStore.getState()
    const chain = state.chain as ChamferChainState
    expect(chain.kind).toBe('chamfer')
    expect(chain.corners).toHaveLength(1)
    expect(state.chamferSetback).toBeGreaterThan(0)
    expect(h.notices).toHaveLength(0)
  })

  it("non-finite reaches the real stagedSizeSeedPatch's AGGREGATE only via the named 'stale poisoned sibling' hazard: a corner staged as finite-legal, then silently degraded to NaN, poisons the NEXT addition's aggregate and REFUSES", () => {
    const [a1, b1] = rightAngleCorner('poison-1', 20)
    // Second corner needs its own location so pickCorner cannot conflate it with the first.
    const a2 = makeLine('poison-2-a', { x: 100, y: 0 }, { x: 80, y: 0 })
    const b2 = makeLine('poison-2-b', { x: 100, y: 0 }, { x: 100, y: 20 })
    const h = makeHarness([a1, b1, a2, b2])
    bindSketcherDocument(h.doc)

    sketcherTools.armTool('fillet')
    sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false) // stage corner 1 (finite-legal)
    const afterFirst = sketcherToolStore.getState()
    expect((afterFirst.chain as FilletChainState).corners).toHaveLength(1)
    expect(afterFirst.filletRadius).toBeGreaterThan(0)

    // Simulate geometry drift OUTSIDE the tool loop (e.g. a concurrent edit) poisoning the
    // ALREADY-STAGED corner's line -- neither per-addition gate re-checks a corner already staged.
    h.sketch = {
      ...h.sketch,
      entities: h.sketch.entities.map((e) => (e.id === a1.id ? { ...e, end: { x: NaN, y: 0 } } : e)),
    }

    sketcherTools.click({ x: 100, y: 0 }, 0.05, null, false) // add corner 2 -- individually resolvable

    const state = sketcherToolStore.getState()
    // Corner 2's OWN per-addition check passed (checkMixedChainAddition only looks at what is being
    // added), but the AGGREGATE stagedSizeSeedPatch computes now includes the poisoned corner 1 ->
    // non-finite -> the whole addition is refused and the chain reverts to the batch as it stood.
    expect(state.chain).toEqual(afterFirst.chain)
    expect(state.filletRadius, 'refusal must not touch the scalar').toBe(afterFirst.filletRadius)
    expect(h.notices.at(-1)).toMatch(/degenerate \(non-finite size\)/)
  })

  it("no-corner and unresolvable can never reach stagedSizeSeedPatch's seedStagedSize call through the real controller -- proven by construction, not assumed", () => {
    // no-corner: arm with NO preselection at all. Both call sites guard corners.length > 0 before
    // ever calling the chain-level aggregate, so seedStagedSize never runs here -- the scalar is
    // untouched and no notice fires. (Direct coverage: the seedStagedSize runtime census above.)
    const hEmpty = makeHarness([])
    bindSketcherDocument(hEmpty.doc)
    sketcherTools.armTool('fillet')
    expect(sketcherToolStore.getState().filletRadius).toBe(2)
    expect(hEmpty.notices).toHaveLength(0)
    bindSketcherDocument(null)

    // unresolvable: an all-collinear preselection is dropped ENTIRELY by filterMixedChainCorners
    // (every corner classifies dead individually) before stagedSizeSeedPatch's corners.length > 0
    // guard would ever see it -- proven by an EMPTY resulting chain plus the PRESELECTION-DROP
    // notice, not the seed-refusal notice stagedSizeSeedPatch itself would have flashed.
    const [ca, cb] = collinearCorner('unreachable')
    const hDead = makeHarness([ca, cb])
    hDead.selection = [ca.id, cb.id]
    bindSketcherDocument(hDead.doc)
    sketcherTools.armTool('fillet')
    const state = sketcherToolStore.getState()
    expect((state.chain as FilletChainState).corners).toHaveLength(0)
    expect(state.filletRadius, 'the aggregate call never ran').toBe(2)
    expect(hDead.notices[0]).toMatch(/no selected corner can fillet/)
  })

  it('a forged out-of-registry kind fails CLOSED through the real controller (armTool), not only through seedStagedSize called directly', () => {
    const [a, b] = rightAngleCorner('forged', 20)
    const h = makeHarness([a, b])
    h.selection = [a.id, b.id]
    bindSketcherDocument(h.doc)

    const spy = vi.spyOn(stagedSizeDragModule, 'classifyChainMax')
      .mockReturnValue({ kind: 'audit-scratch-forged-kind' } as unknown as ChainMaxResult)

    expect(() => sketcherTools.armTool('fillet')).toThrow(/unhandled chain-max kind/)

    spy.mockRestore()
  })
})

// ---- SKC-46-R4 (MAJOR 1 close-out): no-corner and unresolvable driven through the REAL
// stagedSizeSeedPatch, closing the SECOND bounce on the "drive all five kinds" criterion.
//
// The test above ("no-corner and unresolvable can never reach ... proven by construction, not
// assumed") is still true and stays exactly as committed: real geometry genuinely cannot drive
// these two kinds into the AGGREGATE stagedSizeSeedPatch computes. But "unreachable through real
// geometry" left a real gap the R3 audit found: mutating shouldSeedChainMax's no-corner/
// unresolvable arms (toolController.ts:116-121) went completely unobserved, because nothing in
// the committed suite ever drove those two branches of the switch. The binding preflight
// (FINISHERS-SKC46R4-CAM13R3.preflight.md) closes this the only way possible without
// constructible geometry: a SCOPED injection at the aggregate seam. filletChainMaxRadius /
// chamferChainMaxSetback (toolController.ts:164/:180) are the ONLY production call sites of the
// per-chain aggregate -- `vi.spyOn` on those two functions substitutes the aggregate's RETURN
// VALUE only. Every per-corner gate upstream of that call (checkMixedChainAddition,
// filterMixedChainCorners, classifyChainMax, perCornerChainMax, isDeadCorner) stays 100% real:
// the corners driven into these tests are genuinely resolvable geometry that would otherwise
// classify finite-legal, so the ONLY thing forged is the one kind real geometry cannot produce at
// the aggregate.
//
// Both entry shapes are required (preflight amendment 3): FIRST seeding (armTool preselection,
// prevCount===0) always shortcuts `shouldSeedChainMax` to `true` before the switch ever runs
// (toolController.ts:114), so a mutation to the no-corner/unresolvable ARMS is unobservable there
// -- only a LATER addition (click, prevCount>0) actually reaches the switch. The no-corner
// prevCount>0 case asserts the staged scalar is left at its corner-1 SEEDED value (a 20mm-arm
// corner, deliberately far from derivedGrabbableDefault(null) -- the value a wrongly-reseeded
// no-corner arm would jump to), so a mutation that reseeds is a numerically visible RED, not an
// accidental coincidence.
describe('SKC-46-R4: no-corner and unresolvable driven through the REAL stagedSizeSeedPatch (scoped aggregate injection)', () => {
  beforeEach(() => {
    sketcherToolStore.__reset()
  })
  afterEach(() => {
    bindSketcherDocument(null)
    vi.restoreAllMocks()
  })

  const INJECTED_KINDS = ['no-corner', 'unresolvable'] as const

  describe.each(['fillet', 'chamfer'] as const)('%s', (tool) => {
    function spyAggregate(kind: 'no-corner' | 'unresolvable') {
      const forged = { kind } as ChainMaxResult
      return tool === 'fillet'
        ? vi.spyOn(filletToolModule, 'filletChainMaxRadius').mockReturnValue(forged)
        : vi.spyOn(chamferToolModule, 'chamferChainMaxSetback').mockReturnValue(forged)
    }

    /** Two independent resolvable right-angle corners -- real geometry, never forged. */
    function twoCornerSketch(): [SketchEntity, SketchEntity, SketchEntity, SketchEntity] {
      const [a1, b1] = rightAngleCorner(`r4-${tool}-inject-1`, 20)
      const a2 = makeLine(`r4-${tool}-inject-2-a`, { x: 100, y: 0 }, { x: 80, y: 0 })
      const b2 = makeLine(`r4-${tool}-inject-2-b`, { x: 100, y: 0 }, { x: 100, y: 20 })
      return [a1, b1, a2, b2]
    }

    function scalar(): number {
      return tool === 'fillet'
        ? sketcherToolStore.getState().filletRadius
        : sketcherToolStore.getState().chamferSetback
    }

    for (const kind of INJECTED_KINDS) {
      it(`${kind}, FIRST seeding (armTool preselection, prevCount===0): the committed accept/refuse table, via the real controller`, () => {
        const [a, b] = rightAngleCorner(`r4-${tool}-${kind}-first`, 20)
        const h = makeHarness([a, b])
        h.selection = [a.id, b.id]
        bindSketcherDocument(h.doc)

        const spy = spyAggregate(kind)
        sketcherTools.armTool(tool)
        spy.mockRestore()

        const state = sketcherToolStore.getState()
        const chain = state.chain as FilletChainState | ChamferChainState | null
        if (kind === 'no-corner') {
          // seedStagedSize accepts a forged no-corner (it is not a refusal kind): the
          // preselected corner stays staged, seeded at the derived default (no remembered size).
          expect(chain?.corners, 'no-corner is an accept, the preselected corner stays staged').toHaveLength(1)
          expect(scalar(), 'accepted at the derived default (no remembered size)').toBe(derivedGrabbableDefault(null))
          expect(h.notices).toHaveLength(0)
        } else {
          // unresolvable IS a refusal: the whole preselection reverts to the empty armFallback,
          // exactly like a real-geometry refusal would.
          expect(chain?.corners, 'unresolvable is a refusal, the preselection reverts to empty').toHaveLength(0)
          expect(scalar(), 'a refusal must never touch the scalar').toBe(2)
          expect(h.notices).toHaveLength(1)
          expect(h.notices[0]).toMatch(/cannot resolve \(collinear or degenerate\)/)
        }
      })

      it(`${kind}, a LATER addition (click, prevCount>0): the committed accept/refuse table, via the real controller`, () => {
        const [a1, b1, a2, b2] = twoCornerSketch()
        const h = makeHarness([a1, b1, a2, b2])
        bindSketcherDocument(h.doc)

        sketcherTools.armTool(tool)
        sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false) // stage corner 1 for real, no injection
        const afterFirst = sketcherToolStore.getState()
        const corner1Chain = afterFirst.chain as FilletChainState | ChamferChainState
        expect(corner1Chain.corners).toHaveLength(1)
        const corner1Scalar = tool === 'fillet' ? afterFirst.filletRadius : afterFirst.chamferSetback
        // The 20mm-arm corner-1 seed must land far from derivedGrabbableDefault(null) -- otherwise
        // a wrongly-reseeded no-corner arm would coincidentally match and hide the mutation.
        expect(corner1Scalar).toBeGreaterThan(derivedGrabbableDefault(null) + 1)

        const spy = spyAggregate(kind)
        sketcherTools.click({ x: 100, y: 0 }, 0.05, null, false) // add corner 2, aggregate forged
        spy.mockRestore()

        const state = sketcherToolStore.getState()
        const chain = state.chain as FilletChainState | ChamferChainState
        const nowScalar = tool === 'fillet' ? state.filletRadius : state.chamferSetback
        if (kind === 'no-corner') {
          // shouldSeedChainMax's no-corner arm at prevCount>0 must NOT re-seed: corner 2 stages
          // (checkMixedChainAddition already passed it as real, resolvable geometry), and the
          // scalar is left exactly at corner-1's seeded value.
          expect(chain.corners, 'no-corner at prevCount>0 must not undo the addition').toHaveLength(2)
          expect(nowScalar, 'no-corner at prevCount>0 must leave the scalar untouched').toBe(corner1Scalar)
        } else {
          // unresolvable at prevCount>0 must REFUSE the addition outright: the batch reverts to
          // exactly what it was before this click (corner 1 only), scalar untouched.
          expect(chain.corners, 'unresolvable at prevCount>0 must revert the addition').toHaveLength(1)
          expect(nowScalar, 'a refusal must never touch the scalar').toBe(corner1Scalar)
          expect(h.notices.at(-1)).toMatch(/cannot resolve \(collinear or degenerate\)/)
        }
      })
    }
  })
})

// ---- SKC-46-R3 (MAJOR 3 close-out): the +Infinity poisoned-sibling hazard, proved refused by the
// PER-ADDITION controller (checkMixedChainAddition / filterMixedChainCorners), not only at the
// aggregate CLASSIFIER level above (`classifyChainMax([Infinity, 5])`, "silently absorbs...").
//
// A raw +Infinity per-corner ceiling cannot be produced by real finite-coordinate geometry through
// `filletMaxUsableRadius`/`chamferMaxUsableSetback`: an infinite line endpoint poisons the unit-
// direction vector to NaN (Infinity/Infinity) before the ceiling formula ever runs -- which is
// exactly the NaN-sibling hazard `sketcherLifecycle.test.ts`'s mixed-chain suite already covers via
// real geometry. `+Infinity` specifically is reachable only as a VALUE the `number | null`
// per-corner type contract allows (e.g. from a geometric primitive this repo does not have yet, an
// idealized infinite-ray leg) -- so it is driven here the same way the forged-kind test above closes
// its own unconstructible-via-geometry gap: a spy that returns +Infinity for ONE named corner pair
// and delegates to the REAL implementation for every other call. `checkMixedChainAddition`,
// `filterMixedChainCorners`, `classifyChainMax`, and `isDeadCorner` are all 100% real production
// code; only the one poisoned corner's raw ceiling is substituted.
describe('SKC-46-R3: +Infinity poisoned sibling refused by the PER-ADDITION controller (both tools)', () => {
  const originalFilletMax = filletToolModule.filletMaxUsableRadius
  const originalChamferMax = chamferToolModule.chamferMaxUsableSetback

  /** Poisons exactly the (poisonAId, poisonBId) corner pair's raw ceiling to +Infinity; every other
   *  pair still resolves through the REAL geometry function. */
  function poisonCornerToInfinity(
    kind: 'fillet' | 'chamfer', poisonAId: string, poisonBId: string,
  ) {
    const isPoisoned = (aId: string, bId: string): boolean =>
      (aId === poisonAId && bId === poisonBId) || (aId === poisonBId && bId === poisonAId)
    if (kind === 'fillet') {
      return vi.spyOn(filletToolModule, 'filletMaxUsableRadius')
        .mockImplementation((sk, aId, bId, hintA, hintB) =>
          isPoisoned(aId, bId) ? Infinity : originalFilletMax(sk, aId, bId, hintA, hintB))
    }
    return vi.spyOn(chamferToolModule, 'chamferMaxUsableSetback')
      .mockImplementation((sk, aId, bId, hintA, hintB) =>
        isPoisoned(aId, bId) ? Infinity : originalChamferMax(sk, aId, bId, hintA, hintB))
  }

  beforeEach(() => {
    sketcherToolStore.__reset()
  })
  afterEach(() => {
    bindSketcherDocument(null)
    vi.restoreAllMocks()
  })

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    /** A normal, resolvable right-angle corner PLUS a second, independent corner elsewhere whose
     *  raw ceiling the spy substitutes with +Infinity -- same "second independent corner" shape as
     *  the NaN-sibling controller tests in sketcherLifecycle.test.ts, poisoned differently. */
    function twoCornerSketch(): [SketchEntity, SketchEntity, SketchEntity, SketchEntity] {
      const [a1, b1] = rightAngleCorner(`${kind}-inf-1`, 20)
      const a2 = makeLine(`${kind}-inf-2-a`, { x: 100, y: 0 }, { x: 80, y: 0 })
      const b2 = makeLine(`${kind}-inf-2-b`, { x: 100, y: 0 }, { x: 100, y: 20 })
      return [a1, b1, a2, b2]
    }

    it('CLICK addition: a +Infinity-poisoned corner is refused outright, prior batch intact, memory untouched', () => {
      const [a1, b1, a2, b2] = twoCornerSketch()
      const h = makeHarness([a1, b1, a2, b2])
      bindSketcherDocument(h.doc)
      poisonCornerToInfinity(kind, a2.id, b2.id)

      sketcherTools.armTool(kind)
      sketcherTools.click({ x: 0, y: 0 }, 0.05, null, false) // stage the legit first corner
      const afterFirst = sketcherToolStore.getState()
      expect((afterFirst.chain as { corners: unknown[] }).corners, 'first corner must stage').toHaveLength(1)
      h.notices.length = 0

      sketcherTools.click({ x: 100, y: 0 }, 0.05, null, false) // attempt the +Infinity-poisoned corner

      const state = sketcherToolStore.getState()
      expect(state.chain, 'the batch must revert to exactly what it was before this click').toEqual(afterFirst.chain)
      const named = h.notices.filter((n) => new RegExp(kind, 'i').test(n))
      expect(named, `expected a NAMED refusal, got: ${JSON.stringify(h.notices)}`).toHaveLength(1)
      expect(h.lastSizes[kind], 'memory must be untouched').toBeNull()
    })

    it('PRESELECTION: a +Infinity-poisoned sibling is dropped, the resolvable corner stages, ONE named notice counts the drop', () => {
      const [a1, b1, a2, b2] = twoCornerSketch()
      const h = makeHarness([a1, b1, a2, b2])
      h.selection = [a1.id, b1.id, a2.id, b2.id]
      bindSketcherDocument(h.doc)
      poisonCornerToInfinity(kind, a2.id, b2.id)

      sketcherTools.armTool(kind)

      const state = sketcherToolStore.getState()
      const chain = state.chain as { corners: unknown[] }
      expect(chain.corners, 'only the resolvable corner survives the filter').toHaveLength(1)
      const named = h.notices.filter((n) => /1 corner/i.test(n) && new RegExp(kind, 'i').test(n))
      expect(named, `expected ONE named drop-count notice, got: ${JSON.stringify(h.notices)}`).toHaveLength(1)
    })
  })
})
