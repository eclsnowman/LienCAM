import { describe, it, expect } from 'vitest'
import {
  buildNestSources,
  buildNestRequest,
  solverModeFor,
  solverStateFromMode,
  sheetInputsFor,
  isExactChoice,
  mergeNestSettings,
  DEFAULT_NEST_SETTINGS,
  type NestPickerRow,
  type NestModalState,
} from '../../../components/modals/nestPicker'
import type { SolverMode } from '../../../lib/cam/nesting/types'

const row = (over: Partial<NestPickerRow> & { geometryId: string }): NestPickerRow => ({
  included: true,
  quantity: 1,
  locked: false,
  ...over,
})

describe('buildNestSources (P4.1 picker -> CreateNestParams.sources)', () => {
  it('emits only INCLUDED rows', () => {
    const out = buildNestSources([
      row({ geometryId: 'a', included: true }),
      row({ geometryId: 'b', included: false }),
      row({ geometryId: 'c', included: true }),
    ])
    expect(out.map((s) => s.geometryId)).toEqual(['a', 'c'])
  })

  it('passes quantity through', () => {
    const out = buildNestSources([row({ geometryId: 'a', quantity: 7 })])
    expect(out).toEqual([{ geometryId: 'a', quantity: 7 }])
  })

  it('passes the lock flag through (locked => locked:true; unlocked omits it)', () => {
    const out = buildNestSources([
      row({ geometryId: 'locked', locked: true }),
      row({ geometryId: 'free', locked: false }),
    ])
    expect(out[0]).toEqual({ geometryId: 'locked', quantity: 1, locked: true })
    expect(out[1]).toEqual({ geometryId: 'free', quantity: 1 })
    expect('locked' in out[1]).toBe(false)
  })

  it('returns an empty array when no rows are included', () => {
    expect(buildNestSources([])).toEqual([])
    expect(buildNestSources([
      row({ geometryId: 'a', included: false }),
      row({ geometryId: 'b', included: false }),
    ])).toEqual([])
  })

  it('emits ownedByNest:true ONLY for owned rows; omits it otherwise', () => {
    const out = buildNestSources([
      row({ geometryId: 'owned', ownedByNest: true }),
      row({ geometryId: 'preexisting', ownedByNest: false }),
      row({ geometryId: 'undef' }), // ownedByNest left undefined
    ])
    expect(out[0]).toEqual({ geometryId: 'owned', quantity: 1, ownedByNest: true })
    expect(out[1]).toEqual({ geometryId: 'preexisting', quantity: 1 })
    expect('ownedByNest' in out[1]).toBe(false)
    expect(out[2]).toEqual({ geometryId: 'undef', quantity: 1 })
    expect('ownedByNest' in out[2]).toBe(false)
  })

  it('combines locked + ownedByNest on the same source', () => {
    const out = buildNestSources([
      row({ geometryId: 'both', locked: true, ownedByNest: true, quantity: 2 }),
    ])
    expect(out[0]).toEqual({ geometryId: 'both', quantity: 2, locked: true, ownedByNest: true })
  })

  it('floors fractional quantity and clamps below 1 up to 1', () => {
    const out = buildNestSources([
      row({ geometryId: 'a', quantity: 3.9 }),
      row({ geometryId: 'b', quantity: 0 }),
      row({ geometryId: 'c', quantity: -5 }),
    ])
    expect(out).toEqual([
      { geometryId: 'a', quantity: 3 },
      { geometryId: 'b', quantity: 1 },
      { geometryId: 'c', quantity: 1 },
    ])
  })
})

describe('solverModeFor (P4.2 flattened choice -> engine SolverMode)', () => {
  it('maps each choice to the correct SolverMode union member', () => {
    expect(solverModeFor('fixQty-none')).toEqual({ kind: 'fixQty', lockedAxis: 'none' })
    expect(solverModeFor('fixQty-width')).toEqual({ kind: 'fixQty', lockedAxis: 'width' })
    expect(solverModeFor('fixQty-height')).toEqual({ kind: 'fixQty', lockedAxis: 'height' })
    expect(solverModeFor('fixSheet')).toEqual({ kind: 'fixSheet' })
    expect(solverModeFor('fixSheet-exact')).toEqual({ kind: 'fixSheetExact' })
  })
})

describe('solverStateFromMode (P4 EDIT: SolverMode -> flattened modal controls)', () => {
  it('maps each non-ratio mode to its choice (ratio off, 1/1)', () => {
    expect(solverStateFromMode({ kind: 'fixSheet' }))
      .toEqual({ solver: 'fixSheet', ratioLocked: false, ratioW: 1, ratioH: 1 })
    expect(solverStateFromMode({ kind: 'fixSheetExact' }))
      .toEqual({ solver: 'fixSheet-exact', ratioLocked: false, ratioW: 1, ratioH: 1 })
    expect(solverStateFromMode({ kind: 'fixQty', lockedAxis: 'none' }))
      .toEqual({ solver: 'fixQty-none', ratioLocked: false, ratioW: 1, ratioH: 1 })
    expect(solverStateFromMode({ kind: 'fixQty', lockedAxis: 'width' }))
      .toEqual({ solver: 'fixQty-width', ratioLocked: false, ratioW: 1, ratioH: 1 })
    expect(solverStateFromMode({ kind: 'fixQty', lockedAxis: 'height' }))
      .toEqual({ solver: 'fixQty-height', ratioLocked: false, ratioW: 1, ratioH: 1 })
  })

  it('decomposes fixQtyRatio into fixQty-none + ratioLocked with ratioH == ratio (W=1)', () => {
    const s = solverStateFromMode({ kind: 'fixQtyRatio', ratio: 2.5 })
    expect(s).toEqual({ solver: 'fixQty-none', ratioLocked: true, ratioW: 1, ratioH: 2.5 })
    // ratioH / ratioW == the stored ratio.
    expect(s.ratioH / s.ratioW).toBe(2.5)
  })

  it('mode -> choice -> mode round-trips for every non-ratio SolverMode (solverModeFor inverse)', () => {
    const modes: SolverMode[] = [
      { kind: 'fixSheet' },
      { kind: 'fixSheetExact' },
      { kind: 'fixQty', lockedAxis: 'none' },
      { kind: 'fixQty', lockedAxis: 'width' },
      { kind: 'fixQty', lockedAxis: 'height' },
    ]
    for (const mode of modes) {
      const { solver } = solverStateFromMode(mode)
      expect(solverModeFor(solver)).toEqual(mode)
    }
  })

  it('fixQtyRatio round-trips through the modal back to the same ratio via buildNestRequest', () => {
    const mode: SolverMode = { kind: 'fixQtyRatio', ratio: 3 }
    const { solver, ratioLocked, ratioW, ratioH } = solverStateFromMode(mode)
    const params = buildNestRequest({
      rows: [row({ geometryId: 'a', quantity: 1 })],
      solver, ratioLocked, ratioW, ratioH,
      sheet: { width: 100, height: 100 },
      style: 'ninety',
      rotationCount: 4,
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      thickness: 12,
      seed: 1,
    })
    expect(params.solver).toEqual({ kind: 'fixQtyRatio', ratio: 3 })
  })
})

describe('isExactChoice (P4 fix: exact-vs-fill summary format key)', () => {
  it('every mode is EXACT except the explicit fill mode', () => {
    expect(isExactChoice('fixQty-none')).toBe(true)
    expect(isExactChoice('fixQty-width')).toBe(true)
    expect(isExactChoice('fixQty-height')).toBe(true)
    expect(isExactChoice('fixSheet-exact')).toBe(true)
    expect(isExactChoice('fixSheet')).toBe(false)
  })
})

describe('sheetInputsFor (P4.2 which sheet dims a mode consumes)', () => {
  it('fixSheet consumes both width and height', () => {
    expect(sheetInputsFor('fixSheet')).toEqual({ width: true, height: true })
  })
  it('fixQty-width locks width only; fixQty-height locks height only', () => {
    expect(sheetInputsFor('fixQty-width')).toEqual({ width: true, height: false })
    expect(sheetInputsFor('fixQty-height')).toEqual({ width: false, height: true })
  })
  it('fixQty-none consumes neither (auto-size)', () => {
    expect(sheetInputsFor('fixQty-none')).toEqual({ width: false, height: false })
  })
  it('fixSheet-exact consumes both width and height (fixed sheet, exact qty)', () => {
    expect(sheetInputsFor('fixSheet-exact')).toEqual({ width: true, height: true })
  })
})

describe('mergeNestSettings (P4.3 persisted last-used controls -> validated settings)', () => {
  it('returns the fresh defaults (solver fixSheet-exact) when nothing is persisted', () => {
    expect(mergeNestSettings(null)).toEqual(DEFAULT_NEST_SETTINGS)
    expect(mergeNestSettings(undefined)).toEqual(DEFAULT_NEST_SETTINGS)
    expect(DEFAULT_NEST_SETTINGS.solver).toBe('fixSheet-exact')
  })

  it('passes a fully-valid persisted value through', () => {
    const persisted = {
      solver: 'fixQty-width' as const,
      sheet: { width: 250, height: 180 },
      style: 'arbitrary' as const,
      rotationCount: 8,
      spacing: { partGap: 1, sheetMargin: 9, windowGap: 0.5 },
      thickness: 18,
      machiningOrder: 'by-part' as const,
      ratioLocked: true,
      ratioW: 3,
      ratioH: 2,
    }
    expect(mergeNestSettings(persisted)).toEqual(persisted)
  })

  it('falls back to defaults for an unknown solver / style', () => {
    const merged = mergeNestSettings({ solver: 'bogus' as never, style: 'nope' as never })
    expect(merged.solver).toBe(DEFAULT_NEST_SETTINGS.solver)
    expect(merged.style).toBe(DEFAULT_NEST_SETTINGS.style)
  })

  it('falls back to defaults for non-finite / missing numbers and clamps rotationCount >= 2', () => {
    const merged = mergeNestSettings({
      sheet: { width: NaN, height: undefined as never },
      rotationCount: 1,
      spacing: { partGap: NaN, sheetMargin: undefined as never, windowGap: 4 },
    })
    expect(merged.sheet).toEqual(DEFAULT_NEST_SETTINGS.sheet)
    expect(merged.rotationCount).toBe(2)
    expect(merged.spacing.partGap).toBe(DEFAULT_NEST_SETTINGS.spacing.partGap)
    expect(merged.spacing.sheetMargin).toBe(DEFAULT_NEST_SETTINGS.spacing.sheetMargin)
    expect(merged.spacing.windowGap).toBe(4)
  })

  it('round-trips the ratio fields and defaults them when absent/invalid', () => {
    // absent -> defaults (off, 1, 1)
    const def = mergeNestSettings(null)
    expect(def.ratioLocked).toBe(false)
    expect(def.ratioW).toBe(1)
    expect(def.ratioH).toBe(1)
    // valid -> passed through
    const ok = mergeNestSettings({ ratioLocked: true, ratioW: 2, ratioH: 1 })
    expect(ok.ratioLocked).toBe(true)
    expect(ok.ratioW).toBe(2)
    expect(ok.ratioH).toBe(1)
    // invalid (<= 0 / non-finite) ratio components fall back to 1; ratioLocked
    // coerces truthy junk to a strict boolean.
    const bad = mergeNestSettings({
      ratioLocked: 'yes' as never, ratioW: 0, ratioH: NaN,
    })
    expect(bad.ratioLocked).toBe(false) // only === true counts
    expect(bad.ratioW).toBe(1)
    expect(bad.ratioH).toBe(1)
  })
})

describe('buildNestRequest (P4.2 full modal state -> CreateNestParams)', () => {
  const baseState = (over: Partial<NestModalState> = {}): NestModalState => ({
    rows: [row({ geometryId: 'a', quantity: 2 })],
    solver: 'fixQty-none',
    sheet: { width: 300, height: 200 },
    style: 'ninety',
    rotationCount: 4,
    spacing: { partGap: 3, sheetMargin: 5, windowGap: 2 },
    thickness: 12,
    seed: 1,
    ...over,
  })

  it('maps sources via buildNestSources (only included rows)', () => {
    const params = buildNestRequest(baseState({
      rows: [row({ geometryId: 'a', quantity: 2 }), row({ geometryId: 'b', included: false })],
    }))
    expect(params.sources).toEqual([{ geometryId: 'a', quantity: 2 }])
  })

  it('fixQty-none -> fixQty/none solver, sheet passed through (auto-sized by engine)', () => {
    const params = buildNestRequest(baseState({ solver: 'fixQty-none' }))
    expect(params.solver).toEqual({ kind: 'fixQty', lockedAxis: 'none' })
    expect(params.sheet).toEqual({ width: 300, height: 200 })
  })

  it('fixQty-width -> fixQty/width solver with the locked width in sheet', () => {
    const params = buildNestRequest(baseState({ solver: 'fixQty-width', sheet: { width: 250, height: 999 } }))
    expect(params.solver).toEqual({ kind: 'fixQty', lockedAxis: 'width' })
    expect(params.sheet.width).toBe(250)
  })

  it('fixQty-height -> fixQty/height solver with the locked height in sheet', () => {
    const params = buildNestRequest(baseState({ solver: 'fixQty-height', sheet: { width: 999, height: 180 } }))
    expect(params.solver).toEqual({ kind: 'fixQty', lockedAxis: 'height' })
    expect(params.sheet.height).toBe(180)
  })

  it('fixSheet -> fixSheet solver with both sheet dims', () => {
    const params = buildNestRequest(baseState({ solver: 'fixSheet', sheet: { width: 400, height: 300 } }))
    expect(params.solver).toEqual({ kind: 'fixSheet' })
    expect(params.sheet).toEqual({ width: 400, height: 300 })
  })

  it('fixSheet-exact -> fixSheetExact solver with the fixed sheet passed through', () => {
    const params = buildNestRequest(baseState({ solver: 'fixSheet-exact', sheet: { width: 400, height: 300 } }))
    expect(params.solver).toEqual({ kind: 'fixSheetExact' })
    expect(params.sheet).toEqual({ width: 400, height: 300 })
  })

  it("includes rotationCount ONLY for style 'arbitrary' (floored, clamped >= 2)", () => {
    const ninety = buildNestRequest(baseState({ style: 'ninety', rotationCount: 8 }))
    expect(ninety.style).toBe('ninety')
    expect('rotationCount' in ninety).toBe(false)

    const arb = buildNestRequest(baseState({ style: 'arbitrary', rotationCount: 8.9 }))
    expect(arb.style).toBe('arbitrary')
    expect(arb.rotationCount).toBe(8)

    const clamped = buildNestRequest(baseState({ style: 'arbitrary', rotationCount: 1 }))
    expect(clamped.rotationCount).toBe(2)
  })

  it('fixQty-none + ratioLocked emits fixQtyRatio with ratio = H / W', () => {
    const params = buildNestRequest(baseState({
      solver: 'fixQty-none', ratioLocked: true, ratioW: 1, ratioH: 2,
    }))
    expect(params.solver).toEqual({ kind: 'fixQtyRatio', ratio: 2 })
  })

  it('fixQty-none + ratioLocked off emits plain fixQty/none (no ratio)', () => {
    const params = buildNestRequest(baseState({
      solver: 'fixQty-none', ratioLocked: false, ratioW: 1, ratioH: 2,
    }))
    expect(params.solver).toEqual({ kind: 'fixQty', lockedAxis: 'none' })
  })

  it('ratioLocked with an invalid (<= 0 / non-finite) ratio falls back to fixQty/none', () => {
    const zero = buildNestRequest(baseState({
      solver: 'fixQty-none', ratioLocked: true, ratioW: 0, ratioH: 2,
    }))
    expect(zero.solver).toEqual({ kind: 'fixQty', lockedAxis: 'none' })
    const nan = buildNestRequest(baseState({
      solver: 'fixQty-none', ratioLocked: true, ratioW: 1, ratioH: NaN,
    }))
    expect(nan.solver).toEqual({ kind: 'fixQty', lockedAxis: 'none' })
  })

  it('ratioLocked is IGNORED for any solver other than fixQty-none', () => {
    const params = buildNestRequest(baseState({
      solver: 'fixSheet-exact', ratioLocked: true, ratioW: 1, ratioH: 2,
    }))
    expect(params.solver).toEqual({ kind: 'fixSheetExact' })
  })

  it('carries ownedByNest from the rows through to sources', () => {
    const params = buildNestRequest(baseState({
      rows: [
        row({ geometryId: 'owned', quantity: 1, ownedByNest: true }),
        row({ geometryId: 'pre', quantity: 1, ownedByNest: false }),
      ],
    }))
    expect(params.sources).toEqual([
      { geometryId: 'owned', quantity: 1, ownedByNest: true },
      { geometryId: 'pre', quantity: 1 },
    ])
  })

  it('passes spacing and seed through unchanged', () => {
    const params = buildNestRequest(baseState({
      spacing: { partGap: 1, sheetMargin: 9, windowGap: 0 },
      seed: 42,
    }))
    expect(params.spacing).toEqual({ partGap: 1, sheetMargin: 9, windowGap: 0 })
    expect(params.seed).toBe(42)
  })
})
