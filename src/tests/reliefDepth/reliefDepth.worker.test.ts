// WO-2173: the photo-depth engine, driven through its worker entry (attachReliefDepthWorker - the handler
// the worker module installs on its own scope) and through the palette's function (estimateReliefDepth)
// with an in-process stand-in Worker. Platform pieces are stand-ins: fetch, Cache Storage, navigator.gpu
// and the onnxruntime-web module (a deterministic fake model). Everything else - the model store, the
// cache path, backend choice and fallback, the tiled pipeline, the 16-bit output - is the production code.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrtLike, OrtSessionLike, OrtTensorLike } from '../../lib/reliefDepth/runtime'
import type { ModelSpec } from '../../lib/reliefDepth/modelStore'
import type { WorkerReply, WorkerRequest, WorkerScopeLike } from '../../lib/reliefDepth/reliefDepth.worker'
import type { DepthImage, DepthOptions, DepthProgress, DepthResult } from '../../lib/reliefDepth/types'

// ---- the stand-in model ------------------------------------------------------------------------------

/** Depth = the view's brightness, 3x3 box-smoothed, plus a gentle dome centred in THIS view (so tiles
 *  disagree with the whole picture the way a real relative-depth model does, and must be aligned). */
function fakeDepth(t: Float32Array, w: number, h: number): Float32Array {
  const plane = w * h
  const lum = new Float32Array(plane)
  for (let i = 0; i < plane; i++) lum[i] = (t[i] + t[plane + i] + t[2 * plane + i]) / 3
  const out = new Float32Array(plane)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { acc += lum[yy * w + xx]; n++ }
    }
    const rx = (x + 0.5) / w - 0.5, ry = (y + 0.5) / h - 0.5
    out[y * w + x] = acc / n + 1.5 * (1 - 4 * (rx * rx + ry * ry))
  }
  return out
}

interface FakeOrt extends OrtLike { creates: string[][]; runs: number; failWebGpu: boolean }

function makeFakeOrt(): FakeOrt {
  const ort: FakeOrt = {
    creates: [], runs: 0, failWebGpu: false,
    env: { wasm: {} },
    Tensor: class implements OrtTensorLike {
      data: Float32Array; dims: readonly number[]
      constructor(_type: 'float32', data: Float32Array, dims: readonly number[]) { this.data = data; this.dims = dims }
    },
    InferenceSession: {
      async create(model: Uint8Array, options: { executionProviders: string[] }): Promise<OrtSessionLike> {
        ort.creates.push(options.executionProviders)
        if (model.byteLength !== FAKE_MODEL.byteLength) throw new Error('not the model bytes')
        if (options.executionProviders[0] === 'webgpu' && ort.failWebGpu) throw new Error('no webgpu device')
        return {
          inputNames: ['pixel_values'], outputNames: ['predicted_depth'],
          async run(feeds) {
            ort.runs++
            const x = feeds.pixel_values
            const [, , h, w] = x.dims
            return { predicted_depth: { data: fakeDepth(x.data as Float32Array, w, h), dims: [1, h, w] } }
          },
        }
      },
    },
  }
  return ort
}

let fakeOrt: FakeOrt = makeFakeOrt()
vi.mock('../../lib/reliefDepth/ortLoader', async () => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/reliefDepth/ortLoader')>({ loadOrt: async () => fakeOrt })
})

const FAKE_MODEL = new Uint8Array(8192).map((_, i) => (i * 131 + 7) & 255)
const FAKE_SPEC: ModelSpec = {
  id: 'fake-depth-model',
  url: 'https://models.example/fake-depth.onnx',
  bytes: FAKE_MODEL.byteLength,
  sha256: createHash('sha256').update(FAKE_MODEL).digest('hex'),
  licence: 'test',
}

// ---- platform stand-ins --------------------------------------------------------------------------------

class FakeCacheStorage {
  stores = new Map<string, Map<string, ArrayBuffer>>()
  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, ArrayBuffer>()
    this.stores.set(name, store)
    return {
      match: async (url: string) => (store.has(url) ? new Response(store.get(url)!.slice(0)) : undefined),
      put: async (url: string, res: Response) => { store.set(url, await res.arrayBuffer()) },
    }
  }
}

let fetchCalls: string[] = []
let modelBody: Uint8Array = FAKE_MODEL

function stubPlatform(opts: { gpu?: boolean } = {}) {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url))
    const body = modelBody
    // Stream it in three chunks so the download progress path is the one a real response takes.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { const k = Math.ceil(body.length / 3); for (let i = 0; i < body.length; i += k) c.enqueue(body.slice(i, i + k)); c.close() },
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.byteLength) } })
  }))
  vi.stubGlobal('caches', new FakeCacheStorage())
  vi.stubGlobal('navigator', opts.gpu ? { gpu: { requestAdapter: async () => ({ name: 'fake adapter' }) } } : {})
}

// ---- the worker entry, on a stand-in scope --------------------------------------------------------------

async function openWorker() {
  const { attachReliefDepthWorker } = await import('../../lib/reliefDepth/reliefDepth.worker')
  const replies: WorkerReply[] = []
  const transfers: Transferable[][] = []
  const scope: WorkerScopeLike = { onmessage: null, postMessage: (m, t) => { replies.push(m); transfers.push(t ?? []) } }
  attachReliefDepthWorker(scope, { model: FAKE_SPEC })
  let id = 0
  const send = (req: WorkerRequest) => scope.onmessage!({ data: req })
  async function estimate(image: DepthImage, options?: DepthOptions) {
    const myId = ++id
    const from = replies.length
    send({ type: 'estimate', id: myId, image, options })
    await vi.waitFor(() => { if (!replies.some(r => r.id === myId && (r.type === 'result' || r.type === 'error'))) throw new Error('waiting') }, { timeout: 20000, interval: 5 })
    const mine = replies.slice(from).filter(r => r.id === myId)
    const end = mine[mine.length - 1]
    const progress = mine.filter((r): r is Extract<WorkerReply, { type: 'progress' }> => r.type === 'progress').map(r => r.progress)
    return { end, progress, transfer: transfers[replies.indexOf(end)] }
  }
  async function dispose() {
    const myId = ++id
    send({ type: 'dispose', id: myId })
    await vi.waitFor(() => { if (!replies.some(r => r.id === myId)) throw new Error('waiting') }, { timeout: 5000, interval: 5 })
  }
  return { estimate, dispose }
}

function lincoln(): DepthImage {
  const f = JSON.parse(readFileSync(new URL('./fixtures/lincoln-90x116.json', import.meta.url), 'utf8')) as { width: number; height: number; rgbBase64: string }
  const rgb = Buffer.from(f.rgbBase64, 'base64')
  const data = new Uint8ClampedArray(f.width * f.height * 4)
  for (let i = 0; i < f.width * f.height; i++) {
    data[i * 4] = rgb[i * 3]; data[i * 4 + 1] = rgb[i * 3 + 1]; data[i * 4 + 2] = rgb[i * 3 + 2]; data[i * 4 + 3] = 255
  }
  return { width: f.width, height: f.height, data }
}

function resultOf(r: WorkerReply): DepthResult {
  if (r.type !== 'result') throw new Error(`expected a result, got ${JSON.stringify(r).slice(0, 300)}`)
  return r.result
}

// A small model side makes the 90 x 116 picture tile the way a real photo does at 518.
const SMALL: DepthOptions = { tuning: { modelSide: 42 } }

beforeEach(() => { fakeOrt = makeFakeOrt(); modelBody = FAKE_MODEL; stubPlatform() })
afterEach(() => { vi.unstubAllGlobals() })

describe('WO-2173 photo depth through the worker entry', () => {
  it('turns a small fixture photo into a 16-bit depth grid of the same size, full range, matching the stored result', async () => {
    const w = await openWorker()
    const { end, transfer } = await w.estimate(lincoln(), SMALL)
    const r = resultOf(end)
    expect([r.width, r.height]).toEqual([90, 116])
    expect(r.heights).toBeInstanceOf(Uint16Array)
    expect(r.heights.length).toBe(90 * 116)
    let lo = 65535, hi = 0
    for (const v of r.heights) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    expect(lo).toBe(0)
    expect(hi).toBe(65535)
    // the whole-picture pass + a 3 x 3 grid of 42 px tiles over 90 x 116
    expect(r.passes).toBe(1 + 3 * 4)
    expect(fakeOrt.runs).toBe(r.passes)
    // the grid is handed back without a copy
    expect(transfer).toContain(r.heights.buffer)

    // Stored result: max difference 64 / 65535 (0.1 % of the range), mean under 4.
    const stored = new URL('./fixtures/lincoln-90x116-depth.json', import.meta.url)
    if (process.env.UPDATE_RELIEF_DEPTH_FIXTURE === '1' || !existsSync(stored)) {
      writeFileSync(stored, JSON.stringify({ note: 'WO-2173 stored result: the fake model of reliefDepth.worker.test.ts on lincoln-90x116, modelSide 42, default options', width: r.width, height: r.height, u16leBase64: Buffer.from(r.heights.buffer).toString('base64') }, null, 1) + '\n')
    }
    const ref = JSON.parse(readFileSync(stored, 'utf8')) as { u16leBase64: string }
    const buf = Buffer.from(ref.u16leBase64, 'base64')
    const want = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
    expect(want.length).toBe(r.heights.length)
    let max = 0, sum = 0
    for (let i = 0; i < want.length; i++) { const d = Math.abs(want[i] - r.heights[i]); max = Math.max(max, d); sum += d }
    expect(max).toBeLessThanOrEqual(64)
    expect(sum / want.length).toBeLessThan(4)
  })

  it('reports download progress on the first run and does not download again on the second (model cache)', async () => {
    const w = await openWorker()
    const first = await w.estimate(lincoln(), SMALL)
    const r1 = resultOf(first.end)
    expect(fetchCalls).toEqual([FAKE_SPEC.url])
    expect(r1.model.fromCache).toBe(false)
    const downloads = first.progress.filter(p => p.stage === 'download')
    expect(downloads.length).toBeGreaterThanOrEqual(2)
    expect(downloads[downloads.length - 1]).toEqual({ stage: 'download', loaded: FAKE_SPEC.bytes, total: FAKE_SPEC.bytes })
    expect(first.progress.some(p => p.stage === 'infer' && p.done === r1.passes && p.total === r1.passes)).toBe(true)

    // Drop the session (as a fresh worker would start) and run again: the bytes come from the cache.
    await w.dispose()
    const second = await w.estimate(lincoln(), SMALL)
    const r2 = resultOf(second.end)
    expect(fetchCalls).toHaveLength(1)
    expect(r2.model.fromCache).toBe(true)
    expect(r2.timings.downloadMs).toBe(0)
    expect(second.progress.some(p => p.stage === 'download')).toBe(false)

    // A brand-new worker in the same browser profile does not download either.
    const w2 = await openWorker()
    resultOf((await w2.estimate(lincoln(), SMALL)).end)
    expect(fetchCalls).toHaveLength(1)
  })

  it('keeps the session between runs in one worker (no second model load)', async () => {
    const w = await openWorker()
    resultOf((await w.estimate(lincoln(), SMALL)).end)
    const again = resultOf((await w.estimate(lincoln(), SMALL)).end)
    expect(fakeOrt.creates).toHaveLength(1)
    expect(again.timings.loadMs).toBe(0)
  })

  it('falls back to WASM when the browser has no WebGPU', async () => {
    const w = await openWorker()
    const r = resultOf((await w.estimate(lincoln(), SMALL)).end)
    expect(r.backend).toBe('wasm')
    expect(fakeOrt.creates).toEqual([['wasm']])
  })

  it('uses WebGPU when an adapter is there, and falls back to WASM when the WebGPU session will not start', async () => {
    stubPlatform({ gpu: true })
    const w = await openWorker()
    expect(resultOf((await w.estimate(lincoln(), SMALL)).end).backend).toBe('webgpu')
    expect(fakeOrt.creates).toEqual([['webgpu']])

    fakeOrt = makeFakeOrt()
    fakeOrt.failWebGpu = true
    stubPlatform({ gpu: true })
    const w2 = await openWorker()
    const r = resultOf((await w2.estimate(lincoln(), SMALL)).end)
    expect(r.backend).toBe('wasm')
    expect(fakeOrt.creates).toEqual([['webgpu'], ['wasm']])
  })

  it('refuses a download whose bytes do not match the pinned SHA-256, and caches nothing', async () => {
    modelBody = FAKE_MODEL.map(v => v ^ 1)
    const w = await openWorker()
    const { end } = await w.estimate(lincoln(), SMALL)
    expect(end.type).toBe('error')
    expect(end.type === 'error' && end.message).toMatch(/SHA-256/)
    modelBody = FAKE_MODEL
    resultOf((await w.estimate(lincoln(), SMALL)).end)
    expect(fetchCalls).toHaveLength(2)
  })

  it("'fast' is one whole-picture pass; 'high' adds the tiles", async () => {
    const w = await openWorker()
    const fast = resultOf((await w.estimate(lincoln(), { ...SMALL, detail: 'fast' })).end)
    expect(fast.passes).toBe(1)
    const high = resultOf((await w.estimate(lincoln(), SMALL)).end)
    expect(high.passes).toBeGreaterThan(1)
    // tiles change the surface (they add detail) without changing its overall form
    let diff = 0, sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0
    const n = fast.heights.length
    for (let i = 0; i < n; i++) {
      const a = fast.heights[i], b = high.heights[i]
      diff += Math.abs(a - b); sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b
    }
    const corr = (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n))
    expect(diff / n).toBeGreaterThan(100)
    expect(corr).toBeGreaterThan(0.8)
  })

  it('keeps the aspect of a wide picture and never returns a grid of another size', async () => {
    const W = 150, H = 40
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = Math.round(127 + 120 * Math.sin(x / 9) * Math.cos(y / 7))
      data.set([v, v, v, 255], (y * W + x) * 4)
    }
    const w = await openWorker()
    const r = resultOf((await w.estimate({ width: W, height: H, data }, { tuning: { modelSide: 28 } })).end)
    expect([r.width, r.height, r.heights.length]).toEqual([W, H, W * H])
  })
})

describe('WO-2173 estimateReliefDepth (the palette call) over a worker', () => {
  it('posts the picture to the depth worker and resolves with its grid, relaying progress', async () => {
    const { attachReliefDepthWorker } = await import('../../lib/reliefDepth/reliefDepth.worker')
    const posted: WorkerRequest[] = []
    const created: unknown[] = []
    class StandInWorker {
      private listeners: { message: ((e: { data: WorkerReply }) => void)[] } = { message: [] }
      private scope: WorkerScopeLike
      constructor(url: URL, options: WorkerOptions) {
        created.push([String(url), options.type])
        this.scope = { onmessage: null, postMessage: m => queueMicrotask(() => this.listeners.message.forEach(l => l({ data: m }))) }
        attachReliefDepthWorker(this.scope, { model: FAKE_SPEC })
      }
      addEventListener(type: 'message' | 'error', l: (e: { data: WorkerReply }) => void) { if (type === 'message') this.listeners.message.push(l) }
      postMessage(m: WorkerRequest) { posted.push(m); this.scope.onmessage!({ data: m }) }
      terminate() {}
    }
    vi.stubGlobal('Worker', StandInWorker)
    const { estimateReliefDepth, disposeReliefDepth } = await import('../../lib/reliefDepth/client')
    try {
      const pic = lincoln()
      const before = pic.data.slice()
      const progress: DepthProgress[] = []
      const r = await estimateReliefDepth(pic, SMALL, p => progress.push(p))
      expect(created).toHaveLength(1)
      expect(String((created[0] as string[])[0])).toMatch(/reliefDepth\.worker\.ts$/)
      expect((created[0] as string[])[1]).toBe('module')
      expect(posted[0].type).toBe('estimate')
      expect([r.width, r.height, r.heights.length]).toEqual([90, 116, 90 * 116])
      expect(progress[progress.length - 1]).toEqual({ stage: 'finish' })
      expect(progress.some(p => p.stage === 'download')).toBe(true)
      // the caller's picture is untouched
      expect(Array.from(pic.data)).toEqual(Array.from(before))
      // a second call reuses the same worker
      await estimateReliefDepth(pic, SMALL)
      expect(created).toHaveLength(1)
    } finally {
      disposeReliefDepth()
    }
  })
})
