// Phase 6 (P10): design-tree filter logic. The matcher is a pure function so
// the "match on name OR type, case-insensitive; ancestors of a match stay
// visible" rule is testable without React.

import { describe, it, expect } from 'vitest'
import {
  normalizeQuery, matchesFilter, isVisible, filteredCountLabel,
} from '../../components/panels/treeFilter'

describe('normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  Drill ')).toBe('drill')
  })
  it('empty/whitespace -> empty string (no filter)', () => {
    expect(normalizeQuery('   ')).toBe('')
    expect(normalizeQuery('')).toBe('')
  })
})

describe('matchesFilter', () => {
  it('empty query matches everything', () => {
    expect(matchesFilter('', 'anything')).toBe(true)
    expect(matchesFilter('', undefined)).toBe(true)
  })
  it('matches on name (case-insensitive substring)', () => {
    expect(matchesFilter('drill', 'Drill 3', 'drill')).toBe(true)
    expect(matchesFilter('CONT', 'Contour 1', 'contour')).toBe(false) // query already lowercased upstream
  })
  it('matches on TYPE field when name does not match', () => {
    expect(matchesFilter('pocket', 'My Op', 'pocket_2d')).toBe(true)
  })
  it('ignores undefined / null / empty fields', () => {
    expect(matchesFilter('x', undefined, null, '')).toBe(false)
  })
  it('returns false when no field matches', () => {
    expect(matchesFilter('zzz', 'Contour 1', 'contour')).toBe(false)
  })
})

describe('isVisible (ancestor-of-a-match stays visible)', () => {
  it('empty query -> always visible', () => {
    expect(isVisible('', false, false)).toBe(true)
  })
  it('self match -> visible', () => {
    expect(isVisible('q', true, false)).toBe(true)
  })
  it('child match -> visible (ancestor kept)', () => {
    expect(isVisible('q', false, true)).toBe(true)
  })
  it('no self and no child match -> hidden', () => {
    expect(isVisible('q', false, false)).toBe(false)
  })
})

describe('filteredCountLabel', () => {
  it('shows plain total when no filter', () => {
    expect(filteredCountLabel(3, 12, '')).toBe('12')
  })
  it('shows shown/total under an active filter', () => {
    expect(filteredCountLabel(3, 12, 'drill')).toBe('3/12')
  })
})
