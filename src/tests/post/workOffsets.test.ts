import { describe, it, expect } from 'vitest'
import {
  usedFixtureOffsets,
  setupNameUsingOffset,
  findWorkOffsetConflicts,
} from '../../lib/post/workOffsets'
import type { Setup } from '../../types'

// Minimal Setup factory — only the fields these pure helpers read
// (id, name, wcs.fixtureOffset). Everything else is structurally filled.
function makeSetup(id: string, name: string, fixtureOffset: number): Setup {
  return {
    id,
    name,
    wcs: {
      id: `wcs-${id}`,
      label: `G${fixtureOffset}`,
      fixtureOffset,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0,
      material: 'wood',
    },
    operations: [],
    notes: '',
  }
}

describe('usedFixtureOffsets', () => {
  it('returns the offsets of all setups when no exceptId given', () => {
    const setups = [
      makeSetup('a', 'Setup 1', 54),
      makeSetup('b', 'Setup 2', 56),
    ]
    expect(usedFixtureOffsets(setups)).toEqual(new Set([54, 56]))
  })

  it('excludes the edited setup so its own offset stays selectable', () => {
    const setups = [
      makeSetup('a', 'Setup 1', 54),
      makeSetup('b', 'Setup 2', 55),
      makeSetup('c', 'Setup 3', 56),
    ]
    // Editing 'b' (G55): G55 must NOT appear as used.
    expect(usedFixtureOffsets(setups, 'b')).toEqual(new Set([54, 56]))
  })

  it('returns an empty set for no setups', () => {
    expect(usedFixtureOffsets([])).toEqual(new Set())
  })

  it('single setup: empty when that setup is the one excluded', () => {
    const setups = [makeSetup('a', 'Setup 1', 54)]
    expect(usedFixtureOffsets(setups, 'a')).toEqual(new Set())
    expect(usedFixtureOffsets(setups)).toEqual(new Set([54]))
  })
})

describe('setupNameUsingOffset', () => {
  const setups = [
    makeSetup('a', 'Roughing', 54),
    makeSetup('b', 'Finishing', 55),
  ]

  it('returns the name of the setup using a given offset', () => {
    expect(setupNameUsingOffset(setups, 54)).toBe('Roughing')
    expect(setupNameUsingOffset(setups, 55)).toBe('Finishing')
  })

  it('returns undefined when no setup uses the offset', () => {
    expect(setupNameUsingOffset(setups, 59)).toBeUndefined()
  })

  it('ignores the excluded setup', () => {
    // Excluding 'a' means G54 is no longer attributed to anyone.
    expect(setupNameUsingOffset(setups, 54, 'a')).toBeUndefined()
    expect(setupNameUsingOffset(setups, 55, 'a')).toBe('Finishing')
  })

  it('returns first match in setup order when duplicated', () => {
    const dup = [
      makeSetup('a', 'First', 54),
      makeSetup('b', 'Second', 54),
    ]
    expect(setupNameUsingOffset(dup, 54)).toBe('First')
  })
})

describe('findWorkOffsetConflicts', () => {
  it('finds a duplicated offset and lists all setup names', () => {
    const setups = [
      makeSetup('a', 'Setup 1', 54),
      makeSetup('b', 'Setup 2', 54),
      makeSetup('c', 'Setup 3', 55),
    ]
    expect(findWorkOffsetConflicts(setups)).toEqual([
      { fixtureOffset: 54, setupNames: ['Setup 1', 'Setup 2'] },
    ])
  })

  it('ignores unique offsets (no conflicts)', () => {
    const setups = [
      makeSetup('a', 'Setup 1', 54),
      makeSetup('b', 'Setup 2', 55),
      makeSetup('c', 'Setup 3', 56),
    ]
    expect(findWorkOffsetConflicts(setups)).toEqual([])
  })

  it('returns conflicts ordered by ascending fixture offset', () => {
    const setups = [
      makeSetup('a', 'A', 57),
      makeSetup('b', 'B', 57),
      makeSetup('c', 'C', 54),
      makeSetup('d', 'D', 54),
    ]
    expect(findWorkOffsetConflicts(setups)).toEqual([
      { fixtureOffset: 54, setupNames: ['C', 'D'] },
      { fixtureOffset: 57, setupNames: ['A', 'B'] },
    ])
  })

  it('returns empty for empty and single-setup projects', () => {
    expect(findWorkOffsetConflicts([])).toEqual([])
    expect(findWorkOffsetConflicts([makeSetup('a', 'Solo', 54)])).toEqual([])
  })
})
