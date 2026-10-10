// Engine tests for the document-agnostic migration chain (ADR-0027).
// Covers the four invariants of runMigrationChain: no-op when current,
// newer-than-supported fail-loud, chain-gap fail-loud, and strict ordering.

import { describe, it, expect } from 'vitest'
import {
  runMigrationChain,
  UnknownSchemaVersionError,
  MissingMigrationError,
  type Migration,
} from '../../store/migrations/schemaMigration'

describe('runMigrationChain (ADR-0027 engine)', () => {
  it('1. is a no-op when from === current (returns the same object)', () => {
    const obj = { a: 1, nested: { b: 2 } }
    const chain: Migration<typeof obj>[] = [
      { to: 1, description: 'noop', up: (d) => ({ ...d, a: 999 }) },
    ]
    const out = runMigrationChain(obj, 1, 1, chain)
    expect(out).toBe(obj) // referential identity -> byte-identical
  })

  it('2. fails loud when the data is newer than current', () => {
    const obj = { a: 1 }
    const chain: Migration<typeof obj>[] = [
      { to: 1, description: 'v1', up: (d) => d },
    ]
    let err: unknown
    try {
      runMigrationChain(obj, 2, 1, chain)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnknownSchemaVersionError)
    const ue = err as UnknownSchemaVersionError
    expect(ue.dataVersion).toBe(2)
    expect(ue.currentVersion).toBe(1)
  })

  it('3. fails loud on a chain gap (missing intermediate step)', () => {
    const obj = { a: 1 }
    const chain: Migration<typeof obj>[] = [
      { to: 1, description: 'v1', up: (d) => d },
      { to: 3, description: 'v3', up: (d) => d },
    ]
    expect(() => runMigrationChain(obj, 0, 3, chain)).toThrow(
      MissingMigrationError,
    )
  })

  it('4. applies up() in strict ascending order', () => {
    type Acc = { order: number[] }
    const chain: Migration<Acc>[] = [
      { to: 1, description: 'v1', up: (d) => ({ order: [...d.order, 1] }) },
      { to: 2, description: 'v2', up: (d) => ({ order: [...d.order, 2] }) },
      { to: 3, description: 'v3', up: (d) => ({ order: [...d.order, 3] }) },
    ]
    const out = runMigrationChain({ order: [] }, 0, 3, chain)
    expect(out.order).toEqual([1, 2, 3])
  })
})
