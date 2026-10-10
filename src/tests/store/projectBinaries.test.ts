// Self-contained .camproject portability (schema v4, ADR-0027).
//
// TASK 1 verification: STL mesh bytes + STEP source bytes must travel INSIDE the
// .camproject JSON so a project opens with every part intact on another browser or
// machine. Today those bytes live only in per-browser IndexedDB (stlCache/stepCache);
// embedding them base64 under Project.binaries + re-hydrating the caches on load
// closes that gap.
//
// The IndexedDB caches are replaced here with in-memory Maps (vi.hoisted) so the
// round trip needs no real IndexedDB AND we can CLEAR them mid-test to simulate a
// fresh browser, then prove the parts restore byte-identical from the file alone.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry } from '../../types'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepPayloadRecord } from '../../lib/cam/geometry/occt/model/modelClient'
import { typedMock } from '../support/typedMock'

const { stlStore, stepStore, displayStore, runtimePayloads } = vi.hoisted(() => ({
  stlStore: new Map<string, ArrayBuffer>(),
  stepStore: new Map<string, ArrayBuffer>(),
  displayStore: new Map<string, CachedStepDisplay>(),
  runtimePayloads: new Map<string, BrepPayloadRecord>(),
}))
const digestFor = (buf: ArrayBuffer) => {
  const byte = new Uint8Array(buf)[0] ?? 0
  return byte.toString(16).padStart(2, '0').repeat(32)
}

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buf: ArrayBuffer) => { stlStore.set(id, buf) }),
  loadCachedSTL: vi.fn(async (id: string) => stlStore.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlStore.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  STEP_DISPLAY_CONTRACT_VERSION: 1,
  STEP_DISPLAY_AO_VERSION: 1,
  computeStepSha256: vi.fn(async (buf: ArrayBuffer) => digestFor(buf)),
  cacheStep: vi.fn(async (
    id: string,
    buf: ArrayBuffer,
    preserveDisplay?: (cached: CachedStepDisplay) => boolean,
  ) => {
    const cached = displayStore.get(id)
    stepStore.set(id, buf)
    if (!cached || !preserveDisplay || !preserveDisplay(cached)) displayStore.delete(id)
  }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  cacheStepDisplay: vi.fn(async (
    id: string, payload: BrepModelPayload, sourceSha256: string, tessellation: StepDisplayTessellation | null,
  ) => {
    displayStore.set(id, {
      displayContractVersion: 1,
      ...(payload.mesh.ao ? { aoVersion: 1 } : {}),
      sourceSha256, tessellation, payload,
      byteLength: 0,
      updatedAt: 0,
    })
  }),
  loadCachedStepDisplay: vi.fn(async (id: string) => displayStore.get(id) ?? null),
  removeCachedStepDisplay: vi.fn(async (id: string) => { displayStore.delete(id) }),
  removeCachedStep: vi.fn(async (id: string) => {
    stepStore.delete(id)
    displayStore.delete(id)
  }),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', () => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  getBrepPayloadRecord: vi.fn((id: string) => runtimePayloads.get(id)),
}))

import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  collectProjectBinaries,
  decodeBrepModelPayload,
  encodeBrepModelPayload,
  hydrateCachesFromBinaries,
} from '../../lib/projectBinaries'
import { cacheSTL, loadCachedSTL } from '../../lib/stlCache'
import {
  cacheStep, cacheStepDisplay, loadCachedStep, loadCachedStepDisplay,
} from '../../lib/stepCache'

// -- helpers -----------------------------------------------------------------------

/** Deterministic, full-byte-range buffer (covers 0..255 so base64 is exercised
 *  over every byte value). */
function makeBytes(len: number, seed: number): ArrayBuffer {
  const b = new Uint8Array(len)
  for (let i = 0; i < len; i++) b[i] = (i * 31 + seed * 7) & 0xff
  return b.buffer
}

const u8 = (buf: ArrayBuffer | null) => new Uint8Array(buf!)

function brepPayload(): BrepModelPayload {
  return {
    faceCount: 2,
    edgeCount: 2,
    solidCount: 3,
    bbox: { min: [-2.5, 0, 1.25], max: [8, 9.5, 10] },
    mesh: {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        0, 0, 1, 1, 0, 1, 0, 1, 1,
      ]),
      normals: new Float32Array([
        0, 0, -1, 0, 0, -1, 0, 0, -1,
        0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceRanges: new Uint32Array([0, 3, 3, 3]),
    },
    edges: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]),
      edgeRanges: new Uint32Array([0, 2, 2, 2]),
    },
    faceTypes: new Uint8Array([0, 6]),
  }
}

function geo(partial: Partial<ImportedGeometry> & Pick<ImportedGeometry, 'id' | 'format'>): ImportedGeometry {
  return {
    name: partial.id, filename: `${partial.id}.${partial.format}`,
    type: partial.format === 'stl' ? 'mesh' : partial.format === 'step' ? 'brep' : 'curves_2d',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...partial,
  } as ImportedGeometry
}

beforeEach(() => {
  stlStore.clear()
  stepStore.clear()
  displayStore.clear()
  runtimePayloads.clear()
  vi.clearAllMocks()
})

describe('projectBinaries: base64 codec', () => {
  it('round-trips arbitrary bytes byte-identical, including across the 32 KiB chunk boundary', () => {
    const buf = makeBytes(70_000, 5) // > 2 chunks (0x8000) -> exercises chunking
    const back = base64ToArrayBuffer(arrayBufferToBase64(buf))
    expect(u8(back)).toEqual(u8(buf))
  })

  it('round-trips an empty buffer', () => {
    const back = base64ToArrayBuffer(arrayBufferToBase64(new ArrayBuffer(0)))
    expect(back.byteLength).toBe(0)
  })
})

describe('projectBinaries: portable STEP display codec', () => {
  it('round-trips every field and typed-array type through JSON', () => {
    const source = brepPayload()
    source.mesh.ao = new Float32Array([0.12, 0.9, 0.8, 0.7, 0.6, 0.5])
    const encoded = encodeBrepModelPayload(source, 'ab'.repeat(32), {
      linearDeflection: 0.1, angularDeflection: 0.2,
    })
    const decoded = decodeBrepModelPayload(JSON.parse(JSON.stringify(encoded)))

    expect(decoded?.payload).toEqual(source)
    expect(decoded?.sourceSha256).toBe('ab'.repeat(32))
    expect(decoded?.tessellation).toEqual({ linearDeflection: 0.1, angularDeflection: 0.2 })
    expect(decoded?.payload.mesh.positions).toBeInstanceOf(Float32Array)
    expect(decoded?.payload.mesh.normals).toBeInstanceOf(Float32Array)
    expect(decoded?.payload.mesh.indices).toBeInstanceOf(Uint32Array)
    expect(decoded?.payload.mesh.faceRanges).toBeInstanceOf(Uint32Array)
    expect(decoded?.payload.mesh.ao).toEqual(source.mesh.ao)
    expect(encoded?.aoVersion).toBe(1)
    expect(decoded?.payload.edges.positions).toBeInstanceOf(Float32Array)
    expect(decoded?.payload.edges.edgeRanges).toBeInstanceOf(Uint32Array)
    expect(decoded?.payload.faceTypes).toBeInstanceOf(Uint8Array)
  })

  it('accepts old displays without AO and ignores invalid optional AO without losing selection', () => {
    const oldEncoded = encodeBrepModelPayload(brepPayload(), 'ac'.repeat(32), null)!
    expect(oldEncoded.aoVersion).toBeUndefined()
    expect(decodeBrepModelPayload(oldEncoded)?.payload.mesh.ao).toBeUndefined()

    const withAo = brepPayload()
    withAo.mesh.ao = new Float32Array([1, 0.9, 0.8, 0.7, 0.6, 0.5])
    const encoded = encodeBrepModelPayload(withAo, 'ad'.repeat(32), null)!
    const decoded = decodeBrepModelPayload({
      ...encoded,
      mesh: { ...encoded.mesh, ao: arrayBufferToBase64(new Float32Array([0.5]).buffer) },
    })

    expect(decoded).not.toBeNull()
    expect(decoded?.payload.mesh.ao).toBeUndefined()
    expect(decoded?.payload.mesh.faceRanges).toEqual(withAo.mesh.faceRanges)
    expect(decoded?.payload.edges.edgeRanges).toEqual(withAo.edges.edgeRanges)
  })

  it('rejects malformed encoding, inconsistent counts/ranges, and out-of-range indices', () => {
    const encoded = encodeBrepModelPayload(brepPayload(), 'cd'.repeat(32), null)!
    expect(decodeBrepModelPayload({ ...encoded, faceTypes: 'not base64!' })).toBeNull()
    expect(decodeBrepModelPayload({ ...encoded, faceCount: 3 })).toBeNull()
    expect(decodeBrepModelPayload({
      ...encoded,
      mesh: {
        ...encoded.mesh,
        faceRanges: arrayBufferToBase64(new Uint32Array([0, 3, 4, 2]).buffer),
      },
    })).toBeNull()
    expect(decodeBrepModelPayload({
      ...encoded,
      mesh: {
        ...encoded.mesh,
        indices: arrayBufferToBase64(new Uint32Array([0, 1, 99, 3, 4, 5]).buffer),
      },
    })).toBeNull()
  })
})

describe('collectProjectBinaries (save side)', () => {
  it('embeds STL + STEP bytes for root parts; ignores 2D geometry', async () => {
    const stlBytes = makeBytes(2048, 1)
    const stepBytes = makeBytes(3000, 2)
    await cacheSTL('g-stl', stlBytes)
    await cacheStep('g-step', stepBytes)

    const binaries = await collectProjectBinaries([
      geo({ id: 'g-stl', format: 'stl' }),
      geo({ id: 'g-step', format: 'step' }),
      geo({ id: 'g-dxf', format: 'dxf', loops: [], layers2d: [] }),
    ])

    expect(binaries).toBeDefined()
    expect(Object.keys(binaries!).sort()).toEqual(['g-step', 'g-stl'])
    expect(binaries!['g-stl'].stl).toBe(arrayBufferToBase64(stlBytes))
    expect(binaries!['g-step'].step).toBe(arrayBufferToBase64(stepBytes))
    // 2D geometry never gets a binary entry.
    expect(binaries!['g-dxf']).toBeUndefined()
  })

  it('embeds a STEP display from runtime first, then the durable cache', async () => {
    const stepBytes = makeBytes(128, 9)
    const payload = brepPayload()
    await cacheStep('g-step', stepBytes)
    const sourceSha256 = digestFor(stepBytes)
    await cacheStepDisplay('g-step', payload, sourceSha256, null)

    let binaries = await collectProjectBinaries([geo({ id: 'g-step', format: 'step' })])
    expect(decodeBrepModelPayload(binaries!['g-step'].stepDisplay)?.payload).toEqual(payload)

    runtimePayloads.set('g-step', {
      displayContractVersion: 1,
      sourceSha256,
      tessellation: { linearDeflection: 0.2, angularDeflection: 0.3 },
      payload: { ...payload, solidCount: 7 },
    })
    binaries = await collectProjectBinaries([geo({ id: 'g-step', format: 'step' })])
    expect(decodeBrepModelPayload(binaries!['g-step'].stepDisplay)?.payload.solidCount).toBe(7)
  })

  it('returns undefined for a 2D-only project (save stays byte-identical to pre-v4)', async () => {
    const binaries = await collectProjectBinaries([
      geo({ id: 'g-dxf', format: 'dxf', loops: [], layers2d: [] }),
      geo({ id: 'g-svg', format: 'svg', loops: [], layers2d: [] }),
    ])
    expect(binaries).toBeUndefined()
  })

  it('SKIPS (WO-1884, Save always writes) a root STL part with no cached bytes, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const binaries = await collectProjectBinaries([
        geo({ id: 'g-stl', name: 'Body', format: 'stl', filename: 'body.stl' }),
      ])
      expect(binaries).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('Body')
    } finally { warn.mockRestore() }
  })

  it('the skip is never silent: the console names the part and its source file, other parts still save', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await cacheSTL('g-ok', makeBytes(16, 3))
      const binaries = await collectProjectBinaries([
        geo({ id: 'g-step', name: 'Bracket', format: 'step', filename: 'bracket.step' }),
        geo({ id: 'g-ok', name: 'Kept', format: 'stl' }),
      ])
      expect(Object.keys(binaries!)).toEqual(['g-ok'])
      expect(warn).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0][0])
      expect(msg).toContain('Bracket')
      expect(msg).toContain('bracket.step')
    } finally { warn.mockRestore() }
  })

  it('EXCLUDES nest-owned seed copies (ownerNestId set) - no embed, no fail-loud', async () => {
    // A seed copied from an STL part keeps format 'stl' under a new id with NO cached
    // bytes; restoreScene skips owned seeds, so they must neither need nor get a binary.
    const binaries = await collectProjectBinaries([
      geo({ id: 'seed-1', format: 'stl', ownerNestId: 'nest-1', loops: [], layers2d: [] }),
    ])
    expect(binaries).toBeUndefined()
  })
})

describe('save -> CLEAR caches -> hydrate (cross-browser round trip)', () => {
  it('restores both STL and STEP bytes byte-identical from the file alone', async () => {
    const stlBytes = makeBytes(5000, 3)
    const stepBytes = makeBytes(4096, 4)
    await cacheSTL('g-stl', stlBytes)
    await cacheStep('g-step', stepBytes)
    const display = brepPayload()
    runtimePayloads.set('g-step', {
      displayContractVersion: 1,
      sourceSha256: digestFor(stepBytes),
      tessellation: null,
      payload: display,
    })

    // SAVE: collect + serialize exactly as saveProjectToFile does.
    const binaries = await collectProjectBinaries([
      geo({ id: 'g-stl', format: 'stl' }),
      geo({ id: 'g-step', format: 'step' }),
    ])
    const json = JSON.stringify({ binaries })

    // SIMULATE A FRESH BROWSER: wipe the caches entirely.
    stlStore.clear()
    stepStore.clear()
    displayStore.clear()
    runtimePayloads.clear()
    expect(await loadCachedSTL('g-stl')).toBeNull()
    expect(await loadCachedStep('g-step')).toBeNull()
    expect(await loadCachedStepDisplay('g-step')).toBeNull()

    // LOAD: parse + hydrate (what loadProjectFromFile does before restoreScene).
    const parsed = JSON.parse(json) as { binaries: NonNullable<ReturnType<typeof JSON.parse>> }
    await hydrateCachesFromBinaries(parsed.binaries)

    // Both parts are back, byte-for-byte.
    expect(u8(await loadCachedSTL('g-stl'))).toEqual(u8(stlBytes))
    expect(u8(await loadCachedStep('g-step'))).toEqual(u8(stepBytes))
    expect((await loadCachedStepDisplay('g-step'))?.payload).toEqual(display)
  })

  it('hydrates raw STEP but ignores a corrupt optional display', async () => {
    const stepBytes = makeBytes(64, 6)
    const encoded = encodeBrepModelPayload(brepPayload(), digestFor(stepBytes), null)!
    await hydrateCachesFromBinaries({
      step: {
        step: arrayBufferToBase64(stepBytes),
        stepDisplay: { ...encoded, faceCount: 999 },
      },
    })

    expect(u8(await loadCachedStep('step'))).toEqual(u8(stepBytes))
    expect(await loadCachedStepDisplay('step')).toBeNull()
  })

  it('preserves a proven matching display across repeated legacy raw-only hydration', async () => {
    const stepBytes = makeBytes(64, 8)
    const matchingDisplay = brepPayload()
    matchingDisplay.faceCount = 1
    matchingDisplay.mesh.faceRanges = new Uint32Array([0, 6])
    matchingDisplay.faceTypes = new Uint8Array([0])
    matchingDisplay.edgeCount = 1
    matchingDisplay.edges.edgeRanges = new Uint32Array([0, 4])
    await cacheStep('same', stepBytes)
    await cacheStepDisplay('same', matchingDisplay, digestFor(stepBytes), null)
    const seeded = await loadCachedStepDisplay('same')

    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(stepBytes) },
    })
    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(stepBytes) },
    })

    expect(await loadCachedStepDisplay('same')).toBe(seeded)
  })

  it('deletes a prior same-id display when legacy raw bytes have a different digest', async () => {
    const firstBytes = makeBytes(64, 8)
    const replacementBytes = makeBytes(64, 9)
    await cacheStep('same', firstBytes)
    await cacheStepDisplay('same', brepPayload(), digestFor(firstBytes), null)

    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(replacementBytes) },
    })

    expect(await loadCachedStepDisplay('same')).toBeNull()
    expect(u8(await loadCachedStep('same'))).toEqual(u8(replacementBytes))
  })

  it('retains a matching local AO upgrade when reopening an old embedded display', async () => {
    const stepBytes = makeBytes(64, 8)
    const oldPortable = encodeBrepModelPayload(brepPayload(), digestFor(stepBytes), null)!
    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(stepBytes), stepDisplay: oldPortable },
    })
    const upgraded = (await loadCachedStepDisplay('same'))!.payload as BrepModelPayload
    upgraded.mesh.ao = new Float32Array(upgraded.mesh.positions.length / 3).fill(0.75)
    await cacheStepDisplay('same', upgraded, digestFor(stepBytes), null)

    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(stepBytes), stepDisplay: oldPortable },
    })

    expect((await loadCachedStepDisplay('same'))?.payload.mesh.ao).toEqual(upgraded.mesh.ao)
  })

  it('rejects a valid display whose digest belongs to different same-id STEP bytes', async () => {
    const currentBytes = makeBytes(64, 2)
    const otherBytes = makeBytes(64, 3)
    const encoded = encodeBrepModelPayload(brepPayload(), digestFor(otherBytes), null)!

    await hydrateCachesFromBinaries({
      same: { step: arrayBufferToBase64(currentBytes), stepDisplay: encoded },
    })

    expect(await loadCachedStepDisplay('same')).toBeNull()
    expect(u8(await loadCachedStep('same'))).toEqual(u8(currentBytes))
  })
})
