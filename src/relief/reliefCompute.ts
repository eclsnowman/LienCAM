// Image relief - where the picture work runs: in the relief worker when the
// page can start one (the app), on the calling thread otherwise (node tests).
// Same functions either way (reliefWorker.ts calls adjust.ts / picture.ts).

import { adjustAny, autoAdjust, autoParams, type AutoParams, type PictureAdjust } from './adjust'
import { capPicture, decodePicture, type Picture } from './picture'
import type { ReliefWorkerRequest, ReliefWorkerResponse } from './reliefWorker'

/** An opened picture: the picture, Auto's choices, and (WO-2174) those choices as adjustment values. */
export interface Opened { picture: Picture; auto: AutoParams; autoAdjust: PictureAdjust; sourceCols: number; sourceRows: number }

export interface ReliefCompute {
  /** decode + Auto; the picture stays known to the worker. sourceCols / sourceRows: the file's own size (the picture is capped at 2048) */
  open(bytes: Uint8Array, mime: string): Promise<Opened>
  /** the adjusted picture (stage 1's Auto filters, or WO-2174's adjustment values) for a picture placed at pitchMm mm per pixel */
  adjust(picture: Picture, params: AutoParams | PictureAdjust, pitchMm: number): Promise<Float32Array>
  dispose(): void
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Pending = { resolve: (r: ReliefWorkerResponse & { ok: true }) => void; reject: (e: Error) => void }

class WorkerCompute implements ReliefCompute {
  private readonly worker: Worker
  private nextId = 1
  private nextKey = 1
  private readonly pending = new Map<number, Pending>()
  private readonly keys = new WeakMap<Picture, number>()

  constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (e: MessageEvent<ReliefWorkerResponse>) => {
      const p = this.pending.get(e.data.id)
      if (p === undefined) return
      this.pending.delete(e.data.id)
      if (e.data.ok) p.resolve(e.data)
      else p.reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'the relief worker stopped'))
      this.pending.clear()
    }
  }

  private call(req: WithoutId<ReliefWorkerRequest>, transfer: Transferable[] = []): Promise<ReliefWorkerResponse & { ok: true }> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...req, id } as ReliefWorkerRequest, transfer)
    })
  }

  async open(bytes: Uint8Array, mime: string): Promise<Opened> {
    const key = this.nextKey++
    const buffer = bytes.slice().buffer
    const res = await this.call({ kind: 'open', key, bytes: buffer, mime }, [buffer])
    const picture = res.picture as Picture
    this.keys.set(picture, key)
    const auto = res.auto as AutoParams
    return { picture, auto, autoAdjust: res.autoAdjust ?? autoAdjust(picture, auto), sourceCols: res.sourceCols ?? picture.cols, sourceRows: res.sourceRows ?? picture.rows }
  }

  async adjust(picture: Picture, params: AutoParams | PictureAdjust, pitchMm: number): Promise<Float32Array> {
    let key = this.keys.get(picture)
    if (key === undefined) {
      key = this.nextKey++
      this.keys.set(picture, key)
      await this.call({ kind: 'put', key, picture: { ...picture, grey: picture.grey.slice() } })
    }
    const res = await this.call({ kind: 'adjust', key, params, pitchMm })
    return res.adjusted as Float32Array
  }

  dispose(): void {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('the relief worker was closed'))
    this.pending.clear()
  }
}

const inThread: ReliefCompute = {
  async open(bytes, mime) {
    const decoded = await decodePicture(bytes, mime)
    const picture = capPicture(decoded)
    const auto = autoParams(picture)
    return { picture, auto, autoAdjust: autoAdjust(picture, auto), sourceCols: decoded.cols, sourceRows: decoded.rows }
  },
  async adjust(picture, params, pitchMm) {
    return adjustAny(picture, params, pitchMm)
  },
  dispose() {},
}

/** The relief worker, or the same work on this thread where no module worker can start. */
export function createReliefCompute(): ReliefCompute {
  if (typeof Worker === 'undefined' || typeof window === 'undefined' || /jsdom/i.test(navigator.userAgent)) return inThread
  try {
    return new WorkerCompute(new Worker(new URL('./reliefWorker.ts', import.meta.url), { type: 'module' }))
  } catch {
    return inThread
  }
}
