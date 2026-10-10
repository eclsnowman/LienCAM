// @vitest-environment jsdom
//
// WO UI-6Y: resizeHoleCandidates/validateResizeDiameter unit coverage.
// WO UI-58: ResizeHoleDialog is DEMOTED to a cross-body SUPPLEMENT list --
// this file's component-level coverage now proves a row click is a plain
// click-select (onSelect(row), no diameter/apply UI of its own), and that
// eligibleResizeHoleVerdicts/buildResizeHoleListRows share the SAME
// eligibility predicate resizeHoleCandidates does (so a hover match in the
// viewport and a list row can never disagree).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ResizeHoleDialog,
  resizeHoleCandidates,
  eligibleResizeHoleVerdicts,
  buildResizeHoleListRows,
  validateResizeDiameter,
  formatMm,
  formatSignedMm,
} from '../../components/model3d/dialogs/ResizeHoleDialog'
import type { FeatureClass, FeatureVerdict } from '../../geom/geom-service'

afterEach(cleanup)

function verdict(
  featureKey: string,
  featureClass: FeatureClass,
  diameter: number | string,
  removable = true,
  refuseReason?: string,
): FeatureVerdict {
  return {
    featureKey,
    featureClass,
    removable,
    ...(refuseReason === undefined ? {} : { refuseReason }),
    effect: 'add',
    faceIds: [`${featureKey}:face`],
    neighbourIds: [],
    params: { diameter },
  }
}

describe('resizeHoleCandidates / eligibleResizeHoleVerdicts share one eligibility predicate (WO UI-6Y / UI-58)', () => {
  it('derives exactly the three hole classes and leaves refused rows visible, disabled, and titled with refuseReason', () => {
    const reason = 'counterbore wall is not reconstructable'
    const verdicts = [
      verdict('through', 'throughHole', 6),
      verdict('blind', 'blindHole', 8),
      verdict('counterbore', 'counterboreStack', 10, false, reason),
      verdict('pocket', 'pocket', 12),
      verdict('fillet', 'filletPlanar', 3),
    ]
    const candidates = resizeHoleCandidates(verdicts)
    expect(candidates.map((candidate) => candidate.featureClass)).toEqual(['throughHole', 'blindHole', 'counterboreStack'])
    expect(candidates[2].disabledReason).toBe(reason)
  })

  it('eligibleResizeHoleVerdicts returns exactly the non-refused, finite-positive-diameter subset resizeHoleCandidates leaves un-disabled, WITH faceIds intact', () => {
    const reason = 'counterbore wall is not reconstructable'
    const verdicts = [
      verdict('through', 'throughHole', 6),
      verdict('blind', 'blindHole', 8),
      verdict('counterbore', 'counterboreStack', 10, false, reason),
      verdict('pocket', 'pocket', 12),
    ]
    const eligible = eligibleResizeHoleVerdicts(verdicts)
    expect(eligible.map((v) => v.featureKey)).toEqual(['through', 'blind'])
    expect(eligible[0].faceIds).toEqual(['through:face'])

    // The refuseReason-carrying row and the pocket row are BOTH excluded from
    // the eligible set, but for different predicate branches -- proves the
    // filter is not accidentally vacuous on either branch.
    const candidateReasons = resizeHoleCandidates(verdicts).map((c) => c.disabledReason)
    expect(candidateReasons).toEqual([undefined, undefined, reason])
  })

  it('excludes a non-finite measured diameter from BOTH the candidate list (as disabled) and the eligible set (dropped entirely)', () => {
    const verdicts = [verdict('bad', 'throughHole', 'unreadable')]
    const candidates = resizeHoleCandidates(verdicts)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].disabledReason).toMatch(/finite positive diameter/i)
    expect(eligibleResizeHoleVerdicts(verdicts)).toEqual([])
  })
})

describe('validateResizeDiameter (WO UI-6Y, reused verbatim by the anchored value entry)', () => {
  it.each([
    ['', 'Enter a new diameter.'],
    ['abc', 'finite number'],
    ['Infinity', 'finite number'],
    ['0', 'greater than 0'],
    ['-2', 'greater than 0'],
    ['6', 'must differ'],
  ])('refuses invalid draft %j before Apply', (draft, message) => {
    const result = validateResizeDiameter(draft, 6)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(message)
  })

  it('computes a signed grow/shrink delta as D - d', () => {
    const grow = validateResizeDiameter('8', 6)
    expect(grow).toEqual({ ok: true, newDiameter: 8, delta: 2 })
    const shrink = validateResizeDiameter('7', 10)
    expect(shrink).toEqual({ ok: true, newDiameter: 7, delta: -3 })
  })
})

describe('formatMm / formatSignedMm', () => {
  it('formats a plain and a signed mm value, and names an unreadable non-finite one', () => {
    expect(formatMm(6)).toBe('6 mm')
    expect(formatSignedMm(2)).toBe('+2 mm')
    expect(formatSignedMm(-3)).toBe('-3 mm')
    expect(formatMm(Number.NaN)).toBe('unreadable')
  })
})

describe('buildResizeHoleListRows (WO UI-58: cross-body supplement flatten)', () => {
  it('flattens per-body verdicts into owner-labeled rows, one per eligible-or-refused candidate', () => {
    const rows = buildResizeHoleListRows([
      { ownerId: 'F1', ownerLabel: 'Body1', verdicts: [verdict('through', 'throughHole', 6)] },
      { ownerId: 'F2', ownerLabel: 'Body2', verdicts: [verdict('blind', 'blindHole', 8), verdict('pocket', 'pocket', 12)] },
    ])
    expect(rows.map((r) => [r.ownerId, r.ownerLabel, r.featureKey])).toEqual([
      ['F1', 'Body1', 'through'],
      ['F2', 'Body2', 'blind'],
    ])
  })
})

describe('ResizeHoleDialog: demoted supplement PICKER (WO UI-58) -- a row click is a click-select, no apply UI of its own', () => {
  it('renders one row per candidate, labeled by owning body, and clicking an enabled row calls onSelect with that row -- never onApply (this component owns no apply path any more)', () => {
    const rows = buildResizeHoleListRows([
      { ownerId: 'F1', ownerLabel: 'Body1', verdicts: [verdict('through', 'throughHole', 6)] },
      { ownerId: 'F2', ownerLabel: 'Body2', verdicts: [verdict('blind', 'blindHole', 8)] },
    ])
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ResizeHoleDialog rows={rows} onSelect={onSelect} onClose={onClose} />)

    const radios = screen.getAllByRole('radio') as HTMLButtonElement[]
    expect(radios).toHaveLength(2)
    expect(radios.map((r) => r.dataset.ownerId)).toEqual(['F1', 'F2'])

    fireEvent.click(radios[1])
    expect(onSelect).toHaveBeenCalledWith(rows[1])
    expect(onSelect).toHaveBeenCalledTimes(1)

    // No diameter input, delta readout, or a second apply surface exists on this demoted component.
    expect(screen.queryByTestId('resize-hole-new-diameter')).toBeNull()
    expect(screen.queryByTestId('resize-hole-delta')).toBeNull()
  })

  it('a disabled (refused) row cannot be selected', () => {
    const reason = 'engine refused'
    const rows = buildResizeHoleListRows([
      { ownerId: 'F1', ownerLabel: 'Body1', verdicts: [verdict('through', 'throughHole', 6, false, reason)] },
    ])
    const onSelect = vi.fn()
    render(<ResizeHoleDialog rows={rows} onSelect={onSelect} onClose={vi.fn()} />)
    const row = screen.getByTestId('resize-hole-option-0') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.getAttribute('data-tooltip')).toBe(reason)
    fireEvent.click(row)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows a named empty state (never a silent blank list) when rows is empty', () => {
    render(<ResizeHoleDialog rows={[]} onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('resize-hole-picker-empty').textContent).toMatch(/no recognized through, blind, or counterbore holes/i)
  })

  it('Close (footer) and the header X both call onClose', () => {
    const onClose = vi.fn()
    render(<ResizeHoleDialog rows={[]} onSelect={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('dialog-shell-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
