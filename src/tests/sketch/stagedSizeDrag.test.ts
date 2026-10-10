// SKC-46 (T-SKC44-FILLETDRAG follow-up); SKC-46-R1 (BLOCKER 1 close-out) rewrote the
// `seedStagedSize` section below; SKC-46-R2 (two-bounce STOP close-out) discriminates the second
// argument into `ChainMaxResult` (see chainMaxCensus.test.ts for the registry/constructor gates).
//
// `derivedGrabbableDefault`/`seedStagedSize` decide the initial staged fillet radius / chamfer
// setback when there is no remembered committed size (Operator: "always defaults to 2mm ... cannot
// grab it unless the part is small or zoomed in a lot"). Chosen rule: GRAB_FRACTION (0.35) of the
// corner's own max-usable size, clamped to [SANE_MIN_MM 0.5, SANE_MAX_MM 25] and never past
// `maxUsable` itself. `startStagedSizeDrag`/`stagedSizeFromDrag` (pre-existing, SKC-44/45) are not
// re-tested here -- covered end-to-end via the pointer gestures in sketcherLifecycle.test.ts.
//
// R1: `seedStagedSize` now returns `{ value, refused }` instead of a bare number -- `maxUsable` is
// documented (by its real callers, filletChainMaxRadius/chamferChainMaxSetback) to already be the
// STRICT per-constructor ceiling, so clamping to it must always be legal; a `maxUsable` below the
// shared MIN_SIZE floor has NO legal value and must be reported as a refusal, never silently
// raised past the ceiling. The REAL preview/apply proof that a clamped seed actually fits (and
// that a sub-floor corner actually refuses end-to-end) lives in filletTool.test.ts /
// chamferTool.test.ts (the real constructors) and sketcherLifecycle.test.ts (the full pointer
// gesture, both tools) -- this file stays pure math on the shared surface.
//
// R2: the bare `number | null` second argument is now the discriminated `ChainMaxResult` --
// `no-corner` replaces `null`, `finite-legal`/`sub-floor` carry the ceiling as `value`, and two
// NEW refusal kinds (`unresolvable`, `non-finite`) exist that R1 could not express at all.

import { describe, it, expect } from 'vitest'
import { derivedGrabbableDefault, seedStagedSize } from '../../lib/sketch/tools/stagedSizeDrag'
import type { ChainMaxResult } from '../../lib/sketch/tools/stagedSizeDrag'

const noCorner: ChainMaxResult = { kind: 'no-corner' }
const unresolvable: ChainMaxResult = { kind: 'unresolvable' }
const nonFinite: ChainMaxResult = { kind: 'non-finite' }
const subFloor = (value: number): ChainMaxResult => ({ kind: 'sub-floor', value })
const finiteLegal = (value: number): ChainMaxResult => ({ kind: 'finite-legal', value })

describe('derivedGrabbableDefault (SKC-46)', () => {
  it('is 35% of maxUsable for a mid-size corner (well inside the sane band)', () => {
    // 0.35 * 20 = 7, inside [0.5, 25] and inside maxUsable=20.
    expect(derivedGrabbableDefault(20)).toBeCloseTo(7, 8)
  })

  it('never exceeds maxUsable, even when the sane band would allow more (small corner)', () => {
    // A 1mm corner: 0.35*1 = 0.35, below SANE_MIN (0.5) -- but must also never exceed maxUsable=1.
    expect(derivedGrabbableDefault(1)).toBeLessThanOrEqual(1)
    expect(derivedGrabbableDefault(1)).toBeGreaterThan(0)
  })

  it('clamps to the sane floor on a tiny corner (never an unusable speck)', () => {
    // 0.35*2 = 0.7 > SANE_MIN(0.5), so the floor only bites below ~1.43mm maxUsable.
    expect(derivedGrabbableDefault(1)).toBeCloseTo(0.5, 8)
  })

  it('clamps to the sane ceiling on a huge corner (never an absurd default)', () => {
    // 0.35*1000 = 350, way past SANE_MAX(25); also below maxUsable=1000 so the ceiling, not the
    // corner, is the binding constraint.
    expect(derivedGrabbableDefault(1000)).toBeCloseTo(25, 8)
  })

  it('falls back to the sane floor when there is no resolvable corner (null maxUsable)', () => {
    expect(derivedGrabbableDefault(null)).toBeCloseTo(0.5, 8)
  })

  it('falls back to the sane floor for a non-finite or non-positive maxUsable', () => {
    expect(derivedGrabbableDefault(0)).toBeCloseTo(0.5, 8)
    expect(derivedGrabbableDefault(-4)).toBeCloseTo(0.5, 8)
    expect(derivedGrabbableDefault(NaN)).toBeCloseTo(0.5, 8)
    expect(derivedGrabbableDefault(Infinity)).toBeCloseTo(0.5, 8)
  })
})

describe('seedStagedSize (SKC-46-R2: discriminated ChainMaxResult contract)', () => {
  it('no remembered size -> the derived grabbable default, not refused', () => {
    const seed = seedStagedSize(null, finiteLegal(20))
    expect(seed.refused).toBe(false)
    expect(seed.value).toBeCloseTo(derivedGrabbableDefault(20), 8)
  })

  it('a remembered size that fits the corner wins over the derived default', () => {
    const seed = seedStagedSize(6, finiteLegal(20))
    expect(seed).toEqual({ value: 6, refused: false })
  })

  it('a remembered size LARGER than the corner clamps down to the corner ceiling (never an impossible preview)', () => {
    // Operator's own example: a remembered 10mm on a 4mm corner. `maxUsable` here stands in for what
    // filletChainMaxRadius/chamferChainMaxSetback now return: the STRICT ceiling, not the bare
    // geometric max -- so clamping to it must never be refused.
    const seed = seedStagedSize(10, finiteLegal(4))
    expect(seed).toEqual({ value: 4, refused: false })
  })

  it('a remembered size is ignored when invalid (zero/negative/non-finite), falling back to derived', () => {
    for (const bad of [0, -3, NaN]) {
      const seed = seedStagedSize(bad, finiteLegal(20))
      expect(seed.refused).toBe(false)
      expect(seed.value).toBeCloseTo(derivedGrabbableDefault(20), 8)
    }
  })

  it('with no corner geometry known (no-corner), a valid remembered size still wins', () => {
    expect(seedStagedSize(6, noCorner)).toEqual({ value: 6, refused: false })
  })

  it('with no corner geometry known and no remembered size, falls back to the sane floor', () => {
    const seed = seedStagedSize(null, noCorner)
    expect(seed.refused).toBe(false)
    expect(seed.value).toBeCloseTo(0.5, 8)
  })

  it('a maxUsable AT the shared 0.01mm floor still seeds (the floor itself is legal)', () => {
    const seed = seedStagedSize(null, finiteLegal(0.01))
    expect(seed.refused).toBe(false)
    expect(seed.value).toBeCloseTo(0.01, 8)
  })

  it('BLOCKER 1: a sub-floor maxUsable REFUSES instead of raising past it', () => {
    // The old bug: a 0.001mm corner's max was silently raised to the 0.01mm field floor, staging a
    // value the corner could never actually take. R1: no legal value exists here, so refuse.
    const seed = seedStagedSize(null, subFloor(0.001))
    expect(seed.refused).toBe(true)
    expect(seed.reasonKind).toBe('sub-floor')
    // A remembered size does not rescue a sub-floor corner either -- the ceiling still governs.
    expect(seedStagedSize(9, subFloor(0.001)).refused).toBe(true)
  })

  it('a maxUsable of exactly 0 (a fully degenerate RESOLVED corner) also refuses, unlike no-corner', () => {
    // no-corner = "no corner geometry known yet" (falls back to the derived default); a finite 0
    // ceiling = "a corner DID resolve but has zero legal room" -- these must NOT be treated the
    // same way (folds into sub-floor per the R2 named collapse ruling).
    expect(seedStagedSize(null, subFloor(0)).refused).toBe(true)
    expect(seedStagedSize(null, noCorner).refused).toBe(false)
  })

  // ---- R2: the two states R1 could not express at all ------------------------------------------

  it('unresolvable (every staged corner is collinear/degenerate/missing) REFUSES, never accepts a default', () => {
    const seed = seedStagedSize(null, unresolvable)
    expect(seed.refused).toBe(true)
    expect(seed.reasonKind).toBe('unresolvable')
    // A remembered size must not rescue it either -- there is no numeric ceiling to clamp to.
    expect(seedStagedSize(10, unresolvable).refused).toBe(true)
  })

  it('non-finite (NaN/+-Infinity poisoned ceiling) REFUSES, never treated as unconstrained or legal', () => {
    const seed = seedStagedSize(null, nonFinite)
    expect(seed.refused).toBe(true)
    expect(seed.reasonKind).toBe('non-finite')
    expect(seedStagedSize(10, nonFinite).refused).toBe(true)
  })
})
