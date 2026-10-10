// GEO-1-R1.4: guard the ACTUAL worker response path's transfer list.
// ===================================================================
// The transferability of the tessellate payload is only real if the WORKER
// (src/geom/worker/geom-worker.ts) actually hands its ArrayBuffers to
// Comlink.transfer. The pure collectTransferables test proves the list is
// correct; it does NOT prove the worker uses it. This test drives the real
// worker module with Comlink + the wasm `?url` import + the engine mocked, then
// asserts geom-worker's tessellate wrapper calls
//   Comlink.transfer(result, collectTransferables(result))
// with the correct transfer list. It FAILS if line 37-39 of geom-worker.ts is
// regressed to a plain `return t` (structured clone) — Comlink.transfer would
// then never be called and the return value would not be the transfer-wrapped
// object.
//
// Approach chosen (stated in the report): a focused mock around Comlink.transfer
// + the wasm `?url` + the engine, rather than a Node worker_threads round trip.
// Reason: geom-worker.ts imports `occt-wasm/dist/occt-wasm.wasm?url` (a
// Vite-only specifier) and constructs the full kernel at module load, neither of
// which loads in a bare Node worker; mocking those two boundaries lets the test
// exercise the exact worker code that builds and tags the transfer list, kernel-
// free and fast, while still failing on the transfer->structured-clone regression.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { collectTransferables } from '../../geom/worker/transfer.ts'
import type { TessBuffers } from '../../geom/geom-service.ts'
import { typedMock } from '../support/typedMock'

// Shared mocks (hoisted so the vi.mock factories and the assertions see the same
// vi.fn instances).
const { transferMock, exposeMock } = vi.hoisted(() => ({
  // transfer() returns a sentinel wrapper so we can prove the worker returned
  // the transfer-tagged value (not the raw buffers).
  transferMock: vi.fn((obj: unknown, transfers: unknown) => ({ __transferred: obj, __transfers: transfers })),
  exposeMock: vi.fn(),
}))

// WO-1052 FINDING: `transfer` is comlink's `<T>(obj: T, transfers:
// Transferable[]) => T` - genuinely generic, so nothing can type-check a mock
// that returns a DIFFERENT shape than its argument. This test's whole point
// is proving the worker propagates Comlink.transfer's return value verbatim
// (line 108 below asserts the final return equals the sentinel wrapper), so
// the mock cannot return `obj` unchanged either - the two requirements
// (typeable, and distinguishable from the raw value) are mutually exclusive.
// Left untyped; see mockContractBaseline.ts.
vi.mock('comlink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('comlink')>()
  return {
    transfer: transferMock,
    expose: exposeMock,
    // Not exercised by geom-worker.ts (it never calls Comlink.proxy); spy-wrap
    // the REAL implementation rather than inventing a fake one, so the mock
    // needs no hand-rolled ProxyMarked branding to type-check.
    proxy: vi.fn(actual.proxy),
  }
})

// The Vite-only wasm URL specifier — mocked so the worker module loads in Node.
vi.mock('occt-wasm/dist/occt-wasm.wasm?url', () => typedMock<typeof import('occt-wasm/dist/occt-wasm.wasm?url')>({
  default: 'mock://occt-wasm.wasm',
}))

// Mock the engine so no real kernel is needed; tessellate returns a real
// TessBuffers with real ArrayBuffers so collectTransferables works normally.
function mockTess(): TessBuffers {
  return {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: ['F1:BOX:zMax'],
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
    edgeOffsets: new Uint32Array([0]),
    edgeIds: ['(a∧b)'],
  }
}

vi.mock('../../geom/worker/geom-engine.ts', () => {
  class GeomEngine {
    constructor(_opts?: unknown) { /* no kernel in this mock */ }
    async tessellate(_h: unknown, _q: unknown): Promise<TessBuffers> { return mockTess() }
  }
  return { GeomEngine }
})

// The exposed Comlink surface, captured from Comlink.expose(api) at module load.
type WorkerApi = { tessellate: (h: unknown, q: unknown) => Promise<unknown> }
let api: WorkerApi

beforeAll(async () => {
  await import('../../geom/worker/geom-worker.ts')
  expect(exposeMock).toHaveBeenCalledTimes(1)
  api = exposeMock.mock.calls[0][0] as WorkerApi
})

describe('geom-worker tessellate transfer path (regression guard)', () => {
  it('calls Comlink.transfer with the tessellate result and its collectTransferables list', async () => {
    transferMock.mockClear()
    const ret = await api.tessellate(1, { deflection: 0.1 })

    // The worker MUST have routed through Comlink.transfer (a `return t`
    // regression would skip it entirely).
    expect(transferMock).toHaveBeenCalledTimes(1)

    const [transferredObj, transferList] = transferMock.mock.calls[0] as [TessBuffers, ArrayBuffer[]]
    // Arg 1 is the tessellate result object itself.
    expect(transferredObj.position).toBeInstanceOf(Float32Array)
    expect(transferredObj.faceIds).toEqual(['F1:BOX:zMax'])
    // Arg 2 is EXACTLY the transfer list collectTransferables builds for it —
    // all six payload buffers, deduped.
    expect(transferList).toEqual(collectTransferables(transferredObj))
    expect(transferList).toHaveLength(6)
    expect(transferList).toContain(transferredObj.position.buffer)
    expect(transferList).toContain(transferredObj.edgeOffsets.buffer)

    // The worker returns the transfer-TAGGED value (our sentinel), proving the
    // return path is Comlink.transfer(...), not a plain structured-clone return.
    expect(ret).toEqual({ __transferred: transferredObj, __transfers: transferList })
  })
})
