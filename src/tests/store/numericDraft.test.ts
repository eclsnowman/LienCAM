// B12 (docs/planning/POST-MERGE-WORKPLAN.md / FEATURE-REQUESTS.md): numeric
// entry fields refused an empty intermediate state - you could not select-all
// and retype because the field snapped back the instant the draft parsed to
// NaN/empty. Fix: NumericInput keeps a local string draft while focused and
// commits the parsed value on blur/Enter, reverting to the last valid value on
// an invalid/empty draft - never pushing NaN/empty into the store mid-typing.
//
// This drives the EXACT commit resolver the shared NumericInput uses on blur,
// so the select-all-overwrite behavior is asserted without a DOM harness.

import { describe, it, expect } from 'vitest'
import { resolveNumericDraft, formatNumUnit } from '../../components/ui/NumericInput'

describe('B12: numeric draft tolerates empty/partial state, commits on blur', () => {
  it('select-all then type "12" -> commits 12', () => {
    const r = resolveNumericDraft('12', 5)
    expect(r.committed).toBe(true)
    expect(r.value).toBe(12)
  })

  it('select-all then Delete (empty draft) -> reverts to last valid, no commit', () => {
    const r = resolveNumericDraft('', 5)
    expect(r.committed).toBe(false)
    expect(r.value).toBe(5)
  })

  it('partial/invalid drafts "-" / "." / "abc" do NOT commit NaN (revert)', () => {
    // Note: these are the drafts that parse to NaN. A draft like "1." is held
    // verbatim in the focused input and only resolved on blur, where
    // parseFloat("1.") === 1 commits legitimately - see the next assertion.
    for (const draft of ['-', '.', 'abc', '']) {
      const r = resolveNumericDraft(draft, 7)
      expect(r.committed, `draft ${JSON.stringify(draft)}`).toBe(false)
      expect(r.value).toBe(7)
    }
    expect(resolveNumericDraft('1.', 7)).toEqual({ value: 1, committed: true })
  })

  it('a valid negative / decimal draft commits', () => {
    expect(resolveNumericDraft('-3.5', 0)).toEqual({ value: -3.5, committed: true })
    expect(resolveNumericDraft('0.1', 9)).toEqual({ value: 0.1, committed: true })
  })

  it('commit clamps to min/max', () => {
    expect(resolveNumericDraft('1', 5, 3)).toEqual({ value: 3, committed: true })   // below min
    expect(resolveNumericDraft('99', 5, 3, 10)).toEqual({ value: 10, committed: true }) // above max
    expect(resolveNumericDraft('6', 5, 3, 10)).toEqual({ value: 6, committed: true })  // in range
  })
})

// ADR-0022 Phase 2a: NumericInput is the single unit-aware input seam. The
// `value`/`onChange`/min/max all stay in mm; only the user's DRAFT and the
// displayed string convert. These assert the commit path (draft display-units
// -> mm) and that the mm path is byte-identical to the original behavior.
describe('ADR-0022: resolveNumericDraft unit-aware commit (inch draft -> mm)', () => {
  it('inch draft converts to mm BEFORE commit (1 in -> 25.4 mm)', () => {
    expect(resolveNumericDraft('1', 0, undefined, undefined, 'inch'))
      .toEqual({ value: 25.4, committed: true })
  })

  it('inch draft clamps in mm space (min/max are mm)', () => {
    // 0.05 in = 1.27 mm, below a 2 mm floor -> clamps to 2 mm
    expect(resolveNumericDraft('0.05', 5, 2, undefined, 'inch'))
      .toEqual({ value: 2, committed: true })
    // 1 in = 25.4 mm, above a 10 mm ceiling -> clamps to 10 mm
    expect(resolveNumericDraft('1', 5, 0, 10, 'inch'))
      .toEqual({ value: 10, committed: true })
  })

  it('explicit units=mm is identity (byte-identical to the no-units path)', () => {
    expect(resolveNumericDraft('12', 5, undefined, undefined, 'mm'))
      .toEqual(resolveNumericDraft('12', 5))
    expect(resolveNumericDraft('99', 5, 3, 10, 'mm'))
      .toEqual(resolveNumericDraft('99', 5, 3, 10))
  })

  it('garbage inch draft does not commit (reverts to last valid mm)', () => {
    expect(resolveNumericDraft('abc', 7, undefined, undefined, 'inch'))
      .toEqual({ value: 7, committed: false })
  })
})

describe('ADR-0022: formatNumUnit display (mm value -> display string)', () => {
  it('mm / undefined units render the ORIGINAL formatNum path (byte-identical)', () => {
    // No float noise, no forced decimals - String(parseFloat(toFixed(10))).
    expect(formatNumUnit(5)).toBe('5')
    expect(formatNumUnit(5, 'mm')).toBe('5')
    expect(formatNumUnit(2.5, 'mm')).toBe('2.5')
    expect(formatNumUnit(0.1, 'mm')).toBe('0.1')
  })

  it('inch converts mm -> in and strips trailing zeros (no 0.3937007874 noise)', () => {
    expect(formatNumUnit(25.4, 'inch')).toBe('1')      // 1.0000 -> 1
    expect(formatNumUnit(12.7, 'inch')).toBe('0.5')    // 0.5000 -> 0.5
    expect(formatNumUnit(10, 'inch')).toBe('0.3937')   // toFixed(4), not 0.3937007874
  })
})
