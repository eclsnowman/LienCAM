// WO-2173: the depth model - where it comes from, and keeping it after the first download.
//
// Depth Anything V2 SMALL is Apache-2.0 (GPL-compatible). Its Base/Large/Giant siblings are CC-BY-NC and are
// never used. fp16 weights: the research measured them identical to fp32 (correlation 0.99999) at half the
// download, where int8 and q4f16 visibly drift; one file serves both WebGPU and the WASM fallback.
//
// The URL is pinned to a repository revision and the bytes are checked against the file's SHA-256, so a
// changed upstream file can never silently change a relief. The download is kept in the browser's Cache
// Storage (Electron's too), falling back to IndexedDB where Cache Storage is unavailable, so the second run
// is offline and instant.

export interface ModelSpec {
  id: string
  url: string
  bytes: number
  sha256: string
  licence: string
}

export const DEPTH_MODEL: ModelSpec = {
  id: 'depth-anything-v2-small-fp16',
  url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_fp16.onnx',
  bytes: 49642442,
  sha256: '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04',
  licence: 'Apache-2.0 (Depth Anything V2 Small, https://huggingface.co/depth-anything/Depth-Anything-V2-Small)',
}

export const MODEL_CACHE_NAME = 'liencam-relief-depth-v1'

export interface ModelStoreDeps {
  fetch: typeof fetch
  caches?: CacheStorage
  indexedDB?: IDBFactory
  subtle?: SubtleCrypto
}

export interface LoadedModel {
  bytes: Uint8Array
  fromCache: boolean
  downloadMs: number
}

function platformDeps(): ModelStoreDeps {
  const g = globalThis as typeof globalThis & { caches?: CacheStorage; indexedDB?: IDBFactory }
  return { fetch: g.fetch.bind(g), caches: g.caches, indexedDB: g.indexedDB, subtle: g.crypto?.subtle }
}

async function sha256Hex(subtle: SubtleCrypto | undefined, bytes: Uint8Array): Promise<string | null> {
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// ---- IndexedDB fallback (one object store, key = model URL) --------------------------------------------

function idbOpen(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(MODEL_CACHE_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('models')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(idb: IDBFactory, key: string): Promise<Uint8Array | null> {
  const db = await idbOpen(idb)
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('models', 'readonly').objectStore('models').get(key)
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result as ArrayBuffer) : null)
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}

async function idbPut(idb: IDBFactory, key: string, bytes: Uint8Array): Promise<void> {
  const db = await idbOpen(idb)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('models', 'readwrite')
      tx.objectStore('models').put(bytes.slice().buffer, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally { db.close() }
}

// ---- the store ---------------------------------------------------------------------------------------

async function readCached(spec: ModelSpec, deps: ModelStoreDeps): Promise<Uint8Array | null> {
  try {
    if (deps.caches) {
      const hit = await (await deps.caches.open(MODEL_CACHE_NAME)).match(spec.url)
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer())
        if (bytes.byteLength === spec.bytes) return bytes
      }
      return null
    }
    if (deps.indexedDB) {
      const bytes = await idbGet(deps.indexedDB, spec.url)
      return bytes && bytes.byteLength === spec.bytes ? bytes : null
    }
  } catch { /* an unreadable cache is a cache miss; the download refills it */ }
  return null
}

async function writeCached(spec: ModelSpec, deps: ModelStoreDeps, bytes: Uint8Array): Promise<void> {
  try {
    if (deps.caches) {
      const cache = await deps.caches.open(MODEL_CACHE_NAME)
      await cache.put(spec.url, new Response(bytes.slice().buffer, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) } }))
    } else if (deps.indexedDB) {
      await idbPut(deps.indexedDB, spec.url, bytes)
    }
  } catch { /* out of quota or storage disabled: the model still runs, it is just fetched again next time */ }
}

async function download(spec: ModelSpec, deps: ModelStoreDeps, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await deps.fetch(spec.url)
  if (!res.ok) throw new Error(`reliefDepth: model download failed (${res.status} ${res.statusText}) from ${spec.url}`)
  // The pinned size, not the server's content-length (a compressed or wrong header must not size the buffer).
  const total = spec.bytes
  const out = new Uint8Array(total)
  let loaded = 0
  onProgress?.(0, total)
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (loaded + value.byteLength > out.byteLength) throw new Error(`reliefDepth: model download is larger than the pinned ${spec.bytes} bytes`)
      out.set(value, loaded)
      loaded += value.byteLength
      onProgress?.(loaded, total)
    }
  } else {
    const all = new Uint8Array(await res.arrayBuffer())
    if (all.byteLength > out.byteLength) throw new Error(`reliefDepth: model download is larger than the pinned ${spec.bytes} bytes`)
    out.set(all)
    loaded = all.byteLength
    onProgress?.(loaded, total)
  }
  const bytes = out.subarray(0, loaded)
  if (bytes.byteLength !== spec.bytes) throw new Error(`reliefDepth: model download is ${bytes.byteLength} bytes, expected ${spec.bytes}`)
  const hash = await sha256Hex(deps.subtle, bytes)
  if (hash !== null && hash !== spec.sha256) throw new Error(`reliefDepth: model download does not match its pinned SHA-256 (${hash})`)
  return bytes
}

/** The model's bytes: from the cache when present, otherwise downloaded (with progress) and cached. */
export async function loadModel(
  spec: ModelSpec = DEPTH_MODEL,
  onProgress?: (loaded: number, total: number) => void,
  deps: ModelStoreDeps = platformDeps(),
): Promise<LoadedModel> {
  const cached = await readCached(spec, deps)
  if (cached) return { bytes: cached, fromCache: true, downloadMs: 0 }
  const t0 = performance.now()
  const bytes = await download(spec, deps, onProgress)
  const downloadMs = performance.now() - t0
  await writeCached(spec, deps, bytes)
  return { bytes, fromCache: false, downloadMs }
}
