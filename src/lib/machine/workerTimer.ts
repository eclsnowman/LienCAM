// A browser tab may throttle its main-thread timers after it is hidden. Web
// Worker timers keep their cadence, so machine liveness work uses this small
// reusable boundary instead of trusting the page event loop.

let didReportFallback = false

function reportFallbackOnce(): void {
  if (didReportFallback) return
  didReportFallback = true
  console.warn('[workerTimer] Web Worker unavailable; using main-thread setInterval fallback.')
}

const WORKER_SOURCE = `
let timer = null;
self.onmessage = (event) => {
  if (event.data.type === 'stop') {
    if (timer !== null) clearInterval(timer);
    timer = null;
    return;
  }
  if (event.data.type === 'start') {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => self.postMessage('tick'), event.data.intervalMs);
  }
};
`

/** Owns one interval, preferring a Worker and preserving setInterval as the fallback. */
export class WorkerTimer {
  private worker: Worker | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private onTick: (() => void) | null = null

  start(intervalMs: number, onTick: () => void): void {
    this.stop()
    this.onTick = onTick

    if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') {
      let workerUrl: string | null = null
      try {
        workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
        const worker = new Worker(workerUrl)
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === 'tick') this.onTick?.()
        }
        worker.postMessage({ type: 'start', intervalMs })
        this.worker = worker
        return
      } catch {
        // A browser may expose Worker while policy prevents constructing one.
        // That is the same operational case as Worker being unavailable.
      } finally {
        if (workerUrl !== null) URL.revokeObjectURL(workerUrl)
      }
    }

    reportFallbackOnce()
    this.fallbackTimer = setInterval(onTick, intervalMs)
  }

  stop(): void {
    this.onTick = null
    if (this.worker !== null) {
      this.worker.postMessage({ type: 'stop' })
      this.worker.terminate()
      this.worker = null
    }
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
