// INT-17A-R3 C3 GATE: the display cache's bound is enforced TRANSACTIONALLY.
//
// The round-3 audit's C3 had three parts, and this file gates all three:
//   1. the payload was committed in one transaction and evicted in a second, so
//      a failure between them left the store permanently over cap;
//   2. that failure could also be silent, because the production call site
//      launches writes without awaiting and swallows rejections;
//   3. unreadable/legacy rows were counted as bytes=0, so the BYTE cap - the
//      primary cap - could not bound them at all.
//
// The over-cap leak itself is reproduced RED-first in int17aR3Repro.test.ts
// (513 rows committed against a 512 cap). This file is the standing gate: it
// asserts the cured invariant from both directions and covers the two parts the
// repro does not - loudness, and legacy-row reclamation.
//
// THE INVARIANT, stated once: after any cacheModelBodyDisplay call, whether it
// resolved or rejected, the store is within BOTH caps. There is no interleaving
// and no failure that makes an over-cap store observable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'
import {
  cacheModelBodyDisplay,
  loadCachedModelBodyDisplay,
  modelBodyCacheKey,
  estimateDisplayBytes,
  selectModelBodyCacheEvictions,
  MODEL_BODY_DISPLAY_CACHE_DB,
  MODEL_BODY_DISPLAY_CACHE_STORE,
  MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES,
  MODEL_BODY_DISPLAY_CACHE_MAX_BYTES,
} from '../../lib/modelBodyDisplayCache'
import type { ModelBodyDisplay, Vec3, BoundingBox } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const display = (): ModelBodyDisplay => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
  edgeOffsets: new Uint32Array([0, 2]),
  boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }),
} as unknown as ModelBodyDisplay)

describe('INT-17A-R3 C3: transactional cache bound enforcement', () => {
  let idb: FakeIndexedDBHandle

  beforeEach(() => { idb = installFakeIndexedDB() })
  afterEach(() => { idb.restore(); vi.restoreAllMocks() })

  const rows = () => idb.records(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE)
  const rowCount = () => rows().size

  /** Seed `n` recognisable records, oldest first, WITHOUT going through the
   *  module under test. `bytes` is settable so the byte cap is drivable too. */
  function seedRecords(n: number, bytes = 1024): void {
    for (let i = 0; i < n; i++) {
      idb.seed(
        MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
        modelBodyCacheKey('proj-1', `modelbody:S${i}`),
        {
          schema: 2, projectId: 'proj-1', geometryId: `modelbody:S${i}`,
          bodyId: `S${i}`, version: 1, savedAt: 1000 + i, bytes,
          display: display(),
        },
      )
    }
  }

  const write = (geometryId: string) => cacheModelBodyDisplay(
    { projectId: 'proj-1', geometryId, bodyId: geometryId.replace('modelbody:', ''), version: 1 },
    display(),
  )

  it('an eviction failure is LOUD and leaves the store within the cap', async () => {
    seedRecords(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)
    idb.failNextDelete()

    // Loud: the promise REJECTS rather than resolving over a broken invariant.
    // (Part 2 of the finding: the production call site swallows this rejection,
    // which is its documented choice - but the module must still report it, and
    // must not leave a broken store behind either way.)
    await expect(write('modelbody:NEW')).rejects.toBeTruthy()

    // Atomic: the put rolled back with the aborted transaction, so the store is
    // at the cap, not one over it - and the payload that could not be kept
    // legally is simply absent, which is recoverable by re-derivation.
    expect(rowCount()).toBe(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEW'))).toBe(false)
  })

  it('a payload-write failure is also loud and commits nothing', async () => {
    seedRecords(3)
    idb.failNextWrite()

    await expect(write('modelbody:NEW')).rejects.toBeTruthy()

    expect(rowCount()).toBe(3)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEW'))).toBe(false)
  })

  it('an ordinary write at the cap evicts the oldest and stays exactly at the cap', async () => {
    seedRecords(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)

    await write('modelbody:NEW')

    expect(rowCount()).toBe(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)
    // The NEW record is in, and the LRW victim (savedAt 1000) is out.
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEW'))).toBe(true)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:S0'))).toBe(false)
    // ...and it is actually readable, so eviction did not take the wrong row.
    await expect(loadCachedModelBodyDisplay(
      { projectId: 'proj-1', geometryId: 'modelbody:NEW', bodyId: 'NEW', version: 1 },
    )).resolves.not.toBeNull()
  })

  it('the BYTE cap is enforced end-to-end, not just by the pure policy', async () => {
    // The R2 round proved the byte cap only through the exported pure policy,
    // and the audit noted the entry cap was the sole end-to-end wiring proof.
    // Sizing four records at a third of the cap each puts the store over budget
    // on bytes while staying far under the 512-entry cap, so ONLY the byte rule
    // can produce an eviction here.
    const third = Math.floor(MODEL_BODY_DISPLAY_CACHE_MAX_BYTES / 3)
    seedRecords(3, third)
    expect(rowCount()).toBe(3)

    await write('modelbody:NEW')

    // 3 x third + the new record exceeds the cap, so at least one must go,
    // and the entry cap (512) cannot possibly be what did it.
    expect(rowCount()).toBeLessThan(4)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEW'))).toBe(true)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:S0'))).toBe(false)

    const totalBytes = [...rows().values()]
      .reduce<number>((sum, r) => sum + ((r as { bytes?: number }).bytes ?? 0), 0)
    expect(totalBytes).toBeLessThanOrEqual(MODEL_BODY_DISPLAY_CACHE_MAX_BYTES)
  })

  it('unrecognised/legacy rows are RECLAIMED, not carried forever at bytes=0', async () => {
    // Part 3 of the finding. An R1-era bare display carries no schema, so this
    // build classifies it null and can never read it - but R2 accounted it as
    // zero bytes, so the byte cap could not bound any number of them. Anything
    // the byte policy cannot measure it cannot bound, so the write path now
    // deletes them inside the same transaction.
    idb.seed(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
      'proj-1 modelbody:LEGACY', display())          // bare, pre-envelope
    idb.seed(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
      'proj-1 modelbody:FOREIGN', { schema: 99, bytes: 1 })  // unknown envelope
    seedRecords(2)
    expect(rowCount()).toBe(4)

    await write('modelbody:NEW')

    expect(rows().has('proj-1 modelbody:LEGACY')).toBe(false)
    expect(rows().has('proj-1 modelbody:FOREIGN')).toBe(false)
    // The rows this build CAN use are untouched - reclamation is scoped to the
    // unreadable ones, not a blanket flush.
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:S0'))).toBe(true)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:S1'))).toBe(true)
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEW'))).toBe(true)
  })

  it('the bound is evaluated against the state ABOUT TO BE committed, including the new row', async () => {
    // The ordering that makes the single transaction correct: the index is read
    // AFTER the put, so the record being written counts toward the cap. Read it
    // before and a store at cap-plus-one is legal by construction.
    seedRecords(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES - 1)

    await write('modelbody:NEW')
    expect(rowCount()).toBe(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)   // exactly full, no eviction needed

    await write('modelbody:NEWER')
    expect(rowCount()).toBe(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES)   // full again: one evicted for one added
    expect(rows().has(modelBodyCacheKey('proj-1', 'modelbody:NEWER'))).toBe(true)
  })

  it('CONTROL: the pure eviction policy still agrees with the wired behaviour', () => {
    // Keeps the exported policy and its call site from drifting apart: R2's
    // byte proof rested entirely on this function, so it must stay honest.
    const bytes = estimateDisplayBytes(display())
    expect(bytes).toBeGreaterThan(0)
    const index = [
      { key: 'a', savedAt: 1, bytes },
      { key: 'b', savedAt: 2, bytes },
      { key: 'c', savedAt: 3, bytes },
    ]
    expect(selectModelBodyCacheEvictions(index, { maxEntries: 2, maxBytes: 1e9 })).toEqual(['a'])
    expect(selectModelBodyCacheEvictions(index, { maxEntries: 512, maxBytes: bytes * 2 }))
      .toEqual(['a'])
    expect(selectModelBodyCacheEvictions(index, { maxEntries: 512, maxBytes: 1e9 })).toEqual([])
  })
})
