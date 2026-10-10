// WO UI-8 (BK-42 mission #1): filter-bar matcher logic (pure functions, no
// React/FeatureDag needed) -- text + :errors/:suppressed/:type operators.

import { describe, it, expect } from 'vitest'
import {
  parseFilterQuery,
  isEmptyFilterQuery,
  matchesFeatureFilter,
  filteredCountLabel,
  type FeatureFilterFacts,
} from '../../components/model3d/tree/treeFilter'

function facts(overrides: Partial<FeatureFilterFacts> = {}): FeatureFilterFacts {
  return { name: 'Extrude1', typeTag: 'extrude', hasErrors: false, suppressed: false, ...overrides }
}

describe('parseFilterQuery', () => {
  it('empty/whitespace -> empty query (no filter)', () => {
    expect(isEmptyFilterQuery(parseFilterQuery(''))).toBe(true)
    expect(isEmptyFilterQuery(parseFilterQuery('   '))).toBe(true)
  })

  it('plain text lowercases and trims', () => {
    expect(parseFilterQuery('  Fillet ').text).toBe('fillet')
  })

  it('recognizes :errors and :suppressed as standalone operators', () => {
    const q = parseFilterQuery(':errors :suppressed')
    expect(q.errors).toBe(true)
    expect(q.suppressed).toBe(true)
    expect(q.text).toBe('')
  })

  it(':type <kind> consumes the following token as the type, case-insensitive', () => {
    const q = parseFilterQuery(':type Extrude')
    expect(q.types).toEqual(['extrude'])
    expect(q.text).toBe('')
  })

  it(':type with no following token is a no-op (never crashes)', () => {
    const q = parseFilterQuery(':type')
    expect(q.types).toEqual([])
  })

  it(':type:kind (no space) is accepted as an alias', () => {
    expect(parseFilterQuery(':type:body').types).toEqual(['body'])
  })

  it('repeated :type accumulates multiple types', () => {
    const q = parseFilterQuery(':type extrude :type revolve')
    expect(q.types).toEqual(['extrude', 'revolve'])
  })

  it('mixes operators with free text', () => {
    const q = parseFilterQuery(':errors boss :type extrude')
    expect(q.errors).toBe(true)
    expect(q.types).toEqual(['extrude'])
    expect(q.text).toBe('boss')
  })

  it('unrecognized :-led token falls through to plain text rather than vanishing', () => {
    const q = parseFilterQuery(':bogus')
    expect(q.text).toBe(':bogus')
  })
})

describe('matchesFeatureFilter', () => {
  it('empty query matches everything', () => {
    expect(matchesFeatureFilter(parseFilterQuery(''), facts())).toBe(true)
  })

  it('text matches name (case-insensitive substring)', () => {
    expect(matchesFeatureFilter(parseFilterQuery('extr'), facts({ name: 'Extrude1' }))).toBe(true)
    expect(matchesFeatureFilter(parseFilterQuery('zzz'), facts({ name: 'Extrude1' }))).toBe(false)
  })

  it('text also matches typeTag when name does not match', () => {
    expect(matchesFeatureFilter(parseFilterQuery('revolve'), facts({ name: 'My Op', typeTag: 'revolve' }))).toBe(true)
  })

  it(':errors excludes healthy features', () => {
    const q = parseFilterQuery(':errors')
    expect(matchesFeatureFilter(q, facts({ hasErrors: true }))).toBe(true)
    expect(matchesFeatureFilter(q, facts({ hasErrors: false }))).toBe(false)
  })

  it(':suppressed excludes non-suppressed features', () => {
    const q = parseFilterQuery(':suppressed')
    expect(matchesFeatureFilter(q, facts({ suppressed: true }))).toBe(true)
    expect(matchesFeatureFilter(q, facts({ suppressed: false }))).toBe(false)
  })

  it(':type <kind> matches only that type', () => {
    const q = parseFilterQuery(':type extrude')
    expect(matchesFeatureFilter(q, facts({ typeTag: 'extrude' }))).toBe(true)
    expect(matchesFeatureFilter(q, facts({ typeTag: 'revolve' }))).toBe(false)
  })

  it('operators AND together with each other and with text', () => {
    const q = parseFilterQuery(':errors :type extrude boss')
    expect(matchesFeatureFilter(q, facts({ hasErrors: true, typeTag: 'extrude', name: 'Boss1' }))).toBe(true)
    // fails :errors
    expect(matchesFeatureFilter(q, facts({ hasErrors: false, typeTag: 'extrude', name: 'Boss1' }))).toBe(false)
    // fails :type
    expect(matchesFeatureFilter(q, facts({ hasErrors: true, typeTag: 'revolve', name: 'Boss1' }))).toBe(false)
    // fails text
    expect(matchesFeatureFilter(q, facts({ hasErrors: true, typeTag: 'extrude', name: 'Cut1' }))).toBe(false)
  })
})

describe('filteredCountLabel', () => {
  it('plain total when no filter', () => {
    expect(filteredCountLabel(3, 12, parseFilterQuery(''))).toBe('12')
  })
  it('shown/total under an active filter', () => {
    expect(filteredCountLabel(3, 12, parseFilterQuery('drill'))).toBe('3/12')
  })
})
