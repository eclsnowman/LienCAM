// WO-2173: the one function the relief palette calls. It posts the picture to the depth worker and resolves
// with the height grid; the main thread only copies bytes in and out.
import type { WorkerReply, WorkerRequest } from './reliefDepth.worker'
import type { DepthImage, DepthOptions, DepthProgress, DepthResult } from './types'

interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerReply>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  terminate(): void
}

let worker: WorkerLike | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: DepthResult) => void; reject: (e: Error) => void; onProgress?: (p: DepthProgress) => void }>()

function start(): WorkerLike {
  if (worker) return worker
  const w = new Worker(new URL('./reliefDepth.worker.ts', import.meta.url), { type: 'module', name: 'relief-depth' }) as unknown as WorkerLike
  w.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
    const msg = event.data
    const job = pending.get(msg.id)
    if (!job) return
    if (msg.type === 'progress') job.onProgress?.(msg.progress)
    else if (msg.type === 'result') { pending.delete(msg.id); job.resolve(msg.result) }
    else if (msg.type === 'error') { pending.delete(msg.id); job.reject(new Error(msg.message)) }
  })
  w.addEventListener('error', (event: ErrorEvent) => {
    const err = new Error(`reliefDepth: the depth worker failed (${event.message || 'unknown error'})`)
    for (const job of pending.values()) job.reject(err)
    pending.clear()
    w.terminate()
    if (worker === w) worker = null
  })
  worker = w
  return w
}

/** Picture in, 16-bit height grid out (same width x height), computed off the main thread. The first call
 *  downloads the model (reported through `onProgress` as stage 'download'); later calls reuse it. */
export function estimateReliefDepth(image: DepthImage, options?: DepthOptions, onProgress?: (p: DepthProgress) => void): Promise<DepthResult> {
  const w = start()
  const id = nextId++
  // Copy so the caller's picture stays usable, then hand the copy's buffer over without a second copy.
  const data = new Uint8ClampedArray(image.data)
  return new Promise<DepthResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    w.postMessage({ type: 'estimate', id, image: { width: image.width, height: image.height, data }, options }, [data.buffer])
  })
}

/** Stops the depth worker and frees the model's memory. The next estimate starts a fresh worker. */
export function disposeReliefDepth(): void {
  if (!worker) return
  worker.terminate()
  worker = null
  const err = new Error('reliefDepth: stopped')
  for (const job of pending.values()) job.reject(err)
  pending.clear()
}
