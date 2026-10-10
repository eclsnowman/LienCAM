import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import {
  cacheStep,
  cacheStepDisplay,
  brepPayloadByteLength,
  loadCachedStep,
  loadCachedStepDisplay,
  removeCachedStep,
} from '../../lib/stepCache'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const DB = 'lien-cam-step-cache'
const RAW = 'step-buffers'
const DISPLAY = 'step-displays'

function payload(): BrepModelPayload {
  return {
    faceCount: 1,
    edgeCount: 1,
    solidCount: 1,
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      faceRanges: new Uint32Array([0, 3]),
    },
    edges: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      edgeRanges: new Uint32Array([0, 2]),
    },
    faceTypes: new Uint8Array([0]),
  }
}

let idb: FakeIndexedDBHandle

beforeEach(() => { idb = installFakeIndexedDB() })
afterEach(() => { idb.restore() })

describe('UI-86 STEP display IndexedDB lifecycle', () => {
  it('accounts for AO bytes and versions AO-bearing records', async () => {
    const displayed = payload()
    const withoutAo = brepPayloadByteLength(displayed)
    displayed.mesh.ao = new Float32Array([1, 0.8, 0.6])
    const raw = new Uint8Array([3]).buffer
    const { computeStepSha256 } = await import('../../lib/stepCache')

    await cacheStepDisplay('ao', displayed, (await computeStepSha256(raw))!, null)
    const cached = await loadCachedStepDisplay('ao')

    expect(cached?.byteLength).toBe(withoutAo + displayed.mesh.ao.byteLength)
    expect(cached?.aoVersion).toBe(1)
    expect(cached?.payload.mesh.ao).toEqual(displayed.mesh.ao)
  })

  it('upgrades a legacy raw-only database without losing the raw entry', async () => {
    const raw = new Uint8Array([1, 2, 3]).buffer
    idb.seed(DB, RAW, 'legacy', raw)
    const digest = (await import('../../lib/stepCache')).computeStepSha256

    await cacheStepDisplay('legacy', payload(), (await digest(raw))!, null)

    expect(new Uint8Array((await loadCachedStep('legacy'))!)).toEqual(new Uint8Array(raw))
    expect((await loadCachedStepDisplay('legacy'))?.payload).toEqual(payload())
    expect(idb.records(DB, RAW).has('legacy')).toBe(true)
    expect(idb.records(DB, DISPLAY).has('legacy')).toBe(true)
  })

  it('removes raw source and display payload together', async () => {
    const raw = new Uint8Array([9, 8, 7]).buffer
    await cacheStep('part', raw)
    const { computeStepSha256 } = await import('../../lib/stepCache')
    await cacheStepDisplay('part', payload(), (await computeStepSha256(raw))!, null)

    await removeCachedStep('part')

    expect(await loadCachedStep('part')).toBeNull()
    expect(await loadCachedStepDisplay('part')).toBeNull()
    expect(idb.records(DB, RAW).has('part')).toBe(false)
    expect(idb.records(DB, DISPLAY).has('part')).toBe(false)
  })

  it('invalidates a display when raw STEP is replaced under the same id', async () => {
    const first = new Uint8Array([1, 1, 1]).buffer
    const replacement = new Uint8Array([2, 2, 2]).buffer
    const { computeStepSha256 } = await import('../../lib/stepCache')
    await cacheStep('same', first)
    await cacheStepDisplay('same', payload(), (await computeStepSha256(first))!, null)

    await cacheStep('same', replacement)

    expect(await loadCachedStepDisplay('same')).toBeNull()
    expect(new Uint8Array((await loadCachedStep('same'))!)).toEqual(new Uint8Array(replacement))
  })

  it('rolls back raw replacement if atomic display invalidation fails', async () => {
    const first = new Uint8Array([4, 4, 4]).buffer
    const replacement = new Uint8Array([5, 5, 5]).buffer
    const { computeStepSha256 } = await import('../../lib/stepCache')
    await cacheStep('atomic', first)
    await cacheStepDisplay('atomic', payload(), (await computeStepSha256(first))!, null)
    idb.failNextDelete()

    await expect(cacheStep('atomic', replacement)).rejects.toThrow(/delete failed/i)

    expect(new Uint8Array((await loadCachedStep('atomic'))!)).toEqual(new Uint8Array(first))
    expect(await loadCachedStepDisplay('atomic')).not.toBeNull()
  })

  it('evicts the oldest display deterministically when the aggregate cap is exceeded', async () => {
    const raw = new Uint8Array([7]).buffer
    const { computeStepSha256 } = await import('../../lib/stepCache')
    await cacheStep('bootstrap', raw)
    const oversizedAccounting = 300 * 1024 * 1024
    idb.seed(DB, DISPLAY, 'oldest', { byteLength: oversizedAccounting, updatedAt: 1 })
    idb.seed(DB, DISPLAY, 'newer', { byteLength: oversizedAccounting, updatedAt: 2 })

    await cacheStepDisplay('fresh', payload(), (await computeStepSha256(raw))!, null)

    expect(idb.records(DB, DISPLAY).has('oldest')).toBe(false)
    expect(idb.records(DB, DISPLAY).has('newer')).toBe(true)
    expect(idb.records(DB, DISPLAY).has('fresh')).toBe(true)
  })

  it('rolls back display insertion if aggregate-cap eviction fails', async () => {
    const raw = new Uint8Array([6]).buffer
    const { computeStepSha256, MAX_STEP_DISPLAY_CACHE_TOTAL_BYTES } = await import('../../lib/stepCache')
    await cacheStep('bootstrap', raw)
    idb.seed(DB, DISPLAY, 'oldest', {
      byteLength: MAX_STEP_DISPLAY_CACHE_TOTAL_BYTES,
      updatedAt: 1,
    })
    idb.failNextDelete()

    await expect(
      cacheStepDisplay('fresh', payload(), (await computeStepSha256(raw))!, null),
    ).rejects.toThrow(/delete failed/i)

    expect(idb.records(DB, DISPLAY).has('oldest')).toBe(true)
    expect(idb.records(DB, DISPLAY).has('fresh')).toBe(false)
  })
})
